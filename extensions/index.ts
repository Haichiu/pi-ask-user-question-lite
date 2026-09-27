/**
 * Adapted from ilovepixelart/pi-code extensions/question.ts (MIT).
 * That implementation is based on Pi's MIT-licensed question example.
 *
 * AskUserQuestion Tool - a question with options, single- or multi-select.
 * Full custom UI: options list + inline editor for "Other…" (single-select only),
 * or space-toggled checkboxes when `multiSelect` is set. An optional `header` labels
 * the question. Left returns to the previous question; Escape keeps its cancel behavior.
 * Multiple questions share one mounted TUI and advance without flicker.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from '@earendil-works/pi-tui'
import { Type } from 'typebox'

interface OptionWithDesc {
  label: string
  description?: string
}

type DisplayOption = OptionWithDesc & { isOther?: boolean }

interface QuestionDetails {
  question: string
  header?: string
  options: string[]
  answer: string | null
  wasCustom?: boolean
  multiSelect?: boolean
}

// Options with labels and optional descriptions
const OptionSchema = Type.Object({
  label: Type.String({ description: 'Display label for the option' }),
  description: Type.Optional(Type.String({ description: 'Optional description shown below label' })),
})

const SingleQuestion = Type.Object({
  question: Type.String({ description: 'The question to ask the user' }),
  header: Type.Optional(Type.String({ description: 'Short label for the question, shown above it, kept to 12 characters' })),
  options: Type.Array(OptionSchema, { description: 'Options for the user to choose from (2-4)', minItems: 2, maxItems: 4 }),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Allow selecting several options (space toggles, enter confirms)' })),
})

/** One question in the flat form, plus an optional batch for Claude's 1-4 questions.
 * The flat fields stay the documented path: a schema offering two equally optional
 * shapes gave smaller models nothing to follow, and they produced neither. */
export const QuestionParams = Type.Object({
  question: Type.Optional(Type.String({ description: 'The question to ask. Required, unless asking several via questions.' })),
  options: Type.Optional(Type.Array(OptionSchema, { description: 'The 2-4 choices for this question, each {label, description?}. Required with question.', minItems: 2, maxItems: 4 })),
  header: Type.Optional(Type.String({ description: 'Optional short label shown above the question, kept to 12 characters' })),
  multiSelect: Type.Optional(Type.Boolean({ description: 'Optional: allow selecting several options (space toggles, enter confirms)' })),
  questions: Type.Optional(Type.Array(SingleQuestion, { description: 'Ask 1-4 questions in one call; each entry takes the same fields as above. Leave unset for the flat single-question form.', minItems: 1, maxItems: 4 })),
})

export interface QuestionSpec {
  question: string
  header?: string
  options: DisplayOption[]
  multiSelect?: boolean
}

/** Normalize either accepted shape into the list of questions to ask. */
function questionList(params: Partial<QuestionSpec> & { questions?: QuestionSpec[] }): QuestionSpec[] {
  if (params.questions && params.questions.length > 0) return params.questions
  if (typeof params.question === 'string') return [{ question: params.question, header: shortHeader(params.header), options: params.options ?? [], multiSelect: params.multiSelect }]
  return []
}

/** Claude keeps a header short for the label slot. Truncating is the forgiving read:
 * rejecting the call costs a turn while the model recovers from a validation error,
 * which is a poor trade for a display detail. */
const HEADER_MAX = 12
const PREVIOUS_LABEL = '← Previous question'
const NEXT_LABEL = '→ Next question'
const otherOption = (): DisplayOption => ({ label: 'Other…', description: 'Press Enter to type your own answer', isOther: true })
const optionsFor = (spec: QuestionSpec): DisplayOption[] => spec.multiSelect === true ? [...spec.options] : [...spec.options, otherOption()]
export const shortHeader = (header: string | undefined): string | undefined => (header === undefined ? undefined : header.slice(0, HEADER_MAX))

function checkbox(checked: boolean | undefined): string {
  if (checked === undefined) return ''
  return checked ? '[x] ' : '[ ] '
}

function optionLine(opt: DisplayOption, index: number, selected: boolean, editMode: boolean, checked: boolean | undefined, theme: Theme): string {
  const label = `${index + 1}. ${checkbox(checked)}${opt.label}`
  const prefix = selected ? theme.fg('accent', '> ') : '  '
  if (opt.isOther === true && editMode) {
    return prefix + theme.fg('accent', `${label} ✎`)
  }
  if (selected) {
    return prefix + theme.fg('accent', label)
  }
  return `  ${theme.fg('text', label)}`
}

interface QuestionView {
  width: number
  question: string
  header?: string
  progress?: string
  options: DisplayOption[]
  optionIndex: number
  editMode: boolean
  multiSelect: boolean
  canGoBack: boolean
  canGoForward: boolean
  checked: boolean[]
  editor: Editor
  theme: Theme
}

function buildQuestionLines(view: QuestionView): string[] {
  const { width, question, header, progress, options, optionIndex, editMode, multiSelect, canGoBack, canGoForward, checked, editor, theme } = view
  const lines: string[] = []
  const add = (s: string) => lines.push(truncateToWidth(s, width))

  add(theme.fg('accent', '─'.repeat(width)))
  if (progress || header) add(theme.fg('muted', ` ${[progress, header ? `[${header}]` : ''].filter(Boolean).join(' • ')}`))
  add(theme.fg('text', ` ${question}`))
  lines.push('')

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    const box = multiSelect && opt.isOther !== true ? checked[i] : undefined
    add(optionLine(opt, i, i === optionIndex, editMode, box, theme))
    if (opt.description) {
      add(`     ${theme.fg('muted', opt.description)}`)
    }
  }

  if (editMode) {
    lines.push('')
    add(theme.fg('muted', ' Your answer:'))
    for (const line of editor.render(width - 2)) {
      add(` ${line}`)
    }
  }

  lines.push('')
  add(theme.fg('dim', navHint(editMode, multiSelect, canGoBack, canGoForward)))
  add(theme.fg('accent', '─'.repeat(width)))

  return lines
}

function navHint(editMode: boolean, multiSelect: boolean, canGoBack: boolean, canGoForward: boolean): string {
  if (editMode) return ' Enter to submit • Esc to return to options'
  const history = [canGoBack ? '← previous' : '', canGoForward ? '→ next' : ''].filter(Boolean).join(' • ')
  const navigation = history ? `${history} • ` : ''
  if (multiSelect) return ` ${navigation}↑↓ navigate • Space to toggle • Enter to confirm • Esc to cancel`
  return ` ${navigation}↑↓ navigate • Enter to select • Esc to cancel`
}

/** The comma-joined labels of the checked options, in order. */
function selectedLabels(options: DisplayOption[], checked: boolean[]): string {
  return options
    .filter((_, i) => checked[i])
    .map((o) => o.label)
    .join(', ')
}

export default function question(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'AskUserQuestion',
    label: 'Ask User Question',
    description:
      'Ask the user to choose among 2-4 clear options when a structured preference, clarification, or direction decision is needed. Use this instead of a plain-text question only when the options are concise and meaningful. Supports an optional short header, Other/free-text for single-select, multi-select, and 1-4 sequential questions. Do not use for open-ended or long-form input; if the selector is unavailable, ask in plain text.',
    parameters: QuestionParams,
    executionMode: 'sequential',

    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      const specs = questionList(rawParams as Partial<QuestionSpec> & { questions?: QuestionSpec[] })
      if (specs.length === 0) {
        return { content: [{ type: 'text', text: 'Error: No question provided' }], details: { question: '', options: [], answer: null } as QuestionDetails }
      }
      if (specs.length === 1) return await askOne(specs[0], ctx)

      // TUI batches stay inside one custom component; RPC keeps native dialogs.
      const interactiveAnswers = ctx.hasUI
        ? ctx.mode === 'tui' ? await askManyViaOverlay(specs, ctx) : await askManyViaDialogs(specs, ctx)
        : undefined
      const texts: string[] = []
      const collected: QuestionDetails[] = []
      for (let i = 0; i < specs.length; i++) {
        const result = interactiveAnswers ? questionResult(specs[i], interactiveAnswers[i] ?? null) : await askOne(specs[i], ctx)
        const detail = result.details as QuestionDetails
        collected.push(detail)
        texts.push(`${specs[i].question}\n${result.content[0].text}`)
        if (detail.answer === null) break
      }
      const cancelled = collected.some((detail) => detail.answer === null)
      return { content: [{ type: 'text', text: texts.join('\n\n') }], details: { ...collected[0], ...(cancelled ? { answer: null } : {}), questions: collected } as QuestionDetails }
    },

    renderCall(args, theme, _context) {
      const multi = args.multiSelect === true
      const heading = args.header ? `[${args.header}] ` : ''
      let text = theme.fg('toolTitle', theme.bold('AskUserQuestion ')) + theme.fg('muted', heading + String(args.question ?? ''))
      const opts = Array.isArray(args.options) ? args.options : []
      if (opts.length) {
        const labels = opts.map((o: OptionWithDesc) => o.label)
        const shown = multi ? labels : [...labels, 'Other…']
        const numbered = shown.map((o, i) => `${i + 1}. ${o}`)
        const optionsLine = `  Options${multi ? ' (multi)' : ''}: ${numbered.join(', ')}`
        text += `\n${theme.fg('dim', optionsLine)}`
      }
      return new Text(text, 0, 0)
    },
    renderResult(result, _options, theme, _context) {
      const details = result.details as QuestionDetails | undefined
      if (!details) {
        const text = result.content[0]
        return new Text(text?.type === 'text' ? text.text : '', 0, 0)
      }

      if (details.answer === null) {
        return new Text(theme.fg('warning', 'Cancelled'), 0, 0)
      }

      if (details.wasCustom) {
        return new Text(theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', details.answer), 0, 0)
      }
      if (details.multiSelect) {
        return new Text(theme.fg('success', '✓ ') + theme.fg('accent', details.answer || '(none)'), 0, 0)
      }
      const idx = details.options.indexOf(details.answer) + 1
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer
      return new Text(theme.fg('success', '✓ ') + theme.fg('accent', display), 0, 0)
    },
  })
}

async function askOne(params: QuestionSpec, ctx: ExtensionContext): Promise<{ content: Array<{ type: 'text'; text: string }>; details: QuestionDetails }> {
  if (!ctx.hasUI) {
    return {
      content: [{ type: 'text', text: `Selector unavailable in ${ctx.mode} mode. Ask the user in plain text instead. Options: ${params.options.map((o) => o.label).join(', ')}` }],
      details: {
        question: params.question,
        options: params.options.map((o) => o.label),
        answer: null,
      } as QuestionDetails,
    }
  }

  if (params.options.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: No options provided' }],
      details: { question: params.question, options: [], answer: null } as QuestionDetails,
    }
  }

  const multiSelect = params.multiSelect === true
  // The free-text option does not compose with checkbox selection, so it is single-select only.
  const allOptions = optionsFor(params)

  // ui.custom() is terminal-only: with a UI but no terminal (RPC mode) it resolves
  // undefined immediately, which would read as a cancel without ever asking. Ask
  // through the dialog primitives there instead.
  const result = ctx.mode === 'tui' ? await askViaOverlay(params, ctx, allOptions, multiSelect) : (await askManyViaDialogs([params], ctx))[0] ?? null

  return questionResult(params, result)
}

function questionResult(params: QuestionSpec, result: QuestionAnswer | null): { content: Array<{ type: 'text'; text: string }>; details: QuestionDetails } {
  const multiSelect = params.multiSelect === true
  const base = { question: params.question, options: params.options.map((o) => o.label), ...(params.header ? { header: shortHeader(params.header) } : {}), ...(multiSelect ? { multiSelect: true } : {}) }
  if (!result) return { content: [{ type: 'text', text: 'User cancelled the selection' }], details: { ...base, answer: null } }
  if (result.wasCustom) return { content: [{ type: 'text', text: `User wrote: ${result.answer}` }], details: { ...base, answer: result.answer, wasCustom: true } }
  const text = multiSelect ? `User selected: ${result.answer || '(none)'}` : `User selected: ${result.index}. ${result.answer}`
  return { content: [{ type: 'text', text }], details: { ...base, answer: result.answer, wasCustom: false } }
}

type QuestionAnswer = { answer: string; wasCustom: boolean; index?: number }

/** Terminal path: one mounted custom UI, including multi-question batches. */
async function askViaOverlay(params: QuestionSpec, ctx: ExtensionContext, _allOptions: DisplayOption[], _multiSelect: boolean): Promise<QuestionAnswer | null> {
  return (await askManyViaOverlay([params], ctx))[0] ?? null
}

async function askManyViaOverlay(specs: QuestionSpec[], ctx: ExtensionContext): Promise<Array<QuestionAnswer | null>> {
  const answers = await (async () => {
    ctx.ui.setWorkingVisible?.(false)
    try {
      return await ctx.ui.custom<Array<QuestionAnswer | null>>((tui: Parameters<Parameters<ExtensionContext['ui']['custom']>[0]>[0], theme: Theme, _kb: unknown, done: (value: Array<QuestionAnswer | null>) => void) => {
        const options = specs.map(optionsFor)
        const checked = options.map((items) => items.map(() => false))
        const drafts: Array<QuestionAnswer | undefined> = Array(specs.length)
        const optionIndexes = specs.map(() => 0)
        const customTexts = specs.map(() => '')
        let questionIndex = 0
        let optionIndex = 0
        let editMode = false
        let cachedLines: string[] | undefined
        let cachedWidth: number | undefined

        const editorTheme: EditorTheme = {
          borderColor: (s) => theme.fg('accent', s),
          selectList: {
            selectedPrefix: (t) => theme.fg('accent', t),
            selectedText: (t) => theme.fg('accent', t),
            description: (t) => theme.fg('muted', t),
            scrollInfo: (t) => theme.fg('dim', t),
            noMatch: (t) => theme.fg('warning', t),
          },
        }
        const editor = new Editor(tui, editorTheme)
        const currentSpec = () => specs[questionIndex]
        const currentOptions = () => options[questionIndex]
        const currentChecked = () => checked[questionIndex]

        function refresh() {
          cachedLines = undefined
          tui.requestRender()
        }

        function moveTo(index: number) {
          optionIndexes[questionIndex] = optionIndex
          questionIndex = index
          optionIndex = optionIndexes[questionIndex]
          editMode = false
          editor.setText('')
        }

        function finishCurrent(answer: QuestionAnswer | null) {
          if (answer === null) {
            done([...drafts.slice(0, questionIndex), null] as Array<QuestionAnswer | null>)
            return
          }
          drafts[questionIndex] = answer
          optionIndexes[questionIndex] = optionIndex
          if (questionIndex === specs.length - 1) {
            done(drafts as QuestionAnswer[])
            return
          }
          moveTo(questionIndex + 1)
        }

        editor.onSubmit = (value) => {
          const trimmed = value.trim()
          if (!trimmed) {
            refresh()
            return
          }
          customTexts[questionIndex] = trimmed
          finishCurrent({ answer: trimmed, wasCustom: true })
          refresh()
        }

        function handleInput(data: string) {
          if (editMode) {
            if (matchesKey(data, Key.escape)) {
              editMode = false
              editor.setText('')
              refresh()
            } else {
              editor.handleInput(data)
              refresh()
            }
            return
          }

          if (matchesKey(data, Key.up)) optionIndex = Math.max(0, optionIndex - 1)
          else if (matchesKey(data, Key.down)) optionIndex = Math.min(currentOptions().length - 1, optionIndex + 1)
          else if (matchesKey(data, Key.left) && questionIndex > 0) moveTo(questionIndex - 1)
          else if (matchesKey(data, Key.right) && questionIndex < specs.length - 1 && drafts[questionIndex] !== undefined) moveTo(questionIndex + 1)
          else if (currentSpec().multiSelect === true && data === ' ') currentChecked()[optionIndex] = !currentChecked()[optionIndex]
          else if (matchesKey(data, Key.enter)) {
            if (currentSpec().multiSelect === true) finishCurrent({ answer: selectedLabels(currentOptions(), currentChecked()), wasCustom: false })
            else {
              const selected = currentOptions()[optionIndex]
              if (selected.isOther) {
                editor.setText(customTexts[questionIndex])
                editMode = true
              } else finishCurrent({ answer: selected.label, wasCustom: false, index: optionIndex + 1 })
            }
          } else if (matchesKey(data, Key.escape)) finishCurrent(null)
          else return
          refresh()
        }

        function render(width: number): string[] {
          if (cachedLines && cachedWidth === width) return cachedLines
          cachedWidth = width
          const spec = currentSpec()
          cachedLines = buildQuestionLines({
            width,
            question: spec.question,
            header: shortHeader(spec.header),
            progress: specs.length > 1 ? `Question ${questionIndex + 1}/${specs.length}` : undefined,
            options: currentOptions(),
            optionIndex,
            editMode,
            multiSelect: spec.multiSelect === true,
            canGoBack: questionIndex > 0,
            canGoForward: questionIndex < specs.length - 1 && drafts[questionIndex] !== undefined,
            checked: currentChecked(),
            editor,
            theme,
          })
          return cachedLines
        }

        return {
          render,
          invalidate: () => {
            cachedWidth = undefined
            cachedLines = undefined
          },
          handleInput,
        }
      })
    } finally {
      ctx.ui.setWorkingVisible?.(true)
    }
  })()
  return answers ?? [null]
}

/** Native-dialog path for RPC and other UI modes without terminal custom components. */
async function askManyViaDialogs(specs: QuestionSpec[], ctx: ExtensionContext): Promise<Array<QuestionAnswer | null>> {
  const options = specs.map(optionsFor)
  const checked = options.map((items) => items.map(() => false))
  const drafts: Array<QuestionAnswer | undefined> = Array(specs.length)
  const customTexts = specs.map(() => '')
  let questionIndex = 0

  while (true) {
    const answer = await askViaDialogs(
      specs[questionIndex],
      ctx,
      options[questionIndex],
      checked[questionIndex],
      questionIndex > 0,
      questionIndex < specs.length - 1 && drafts[questionIndex] !== undefined,
      drafts[questionIndex],
      customTexts[questionIndex],
    )
    if (answer === 'previous') {
      questionIndex -= 1
      continue
    }
    if (answer === 'next') {
      questionIndex += 1
      continue
    }
    if (answer === null) return [...drafts.slice(0, questionIndex), null] as Array<QuestionAnswer | null>

    drafts[questionIndex] = answer
    if (answer.wasCustom) customTexts[questionIndex] = answer.answer
    if (questionIndex === specs.length - 1) return drafts as QuestionAnswer[]
    questionIndex += 1
  }
}

async function askViaDialogs(
  params: QuestionSpec,
  ctx: ExtensionContext,
  allOptions: DisplayOption[],
  checked: boolean[],
  canGoBack: boolean,
  canGoForward: boolean,
  currentAnswer?: QuestionAnswer,
  customText = '',
): Promise<QuestionAnswer | null | 'previous' | 'next'> {
  const header = shortHeader(params.header)
  const current = currentAnswer ? `\nCurrent answer: ${currentAnswer.answer || '(none)'}` : ''
  const title = `${header ? `[${header}] ` : ''}${params.question}${current}`

  if (params.multiSelect === true) {
    while (true) {
      const choices = allOptions.map((option, i) => `${i + 1}. [${checked[i] ? 'x' : ' '}] ${option.label}`)
      choices.push(`${choices.length + 1}. Done`)
      if (canGoBack) choices.push(PREVIOUS_LABEL)
      if (canGoForward) choices.push(NEXT_LABEL)
      const choice = await ctx.ui.select(title, choices)
      if (choice === undefined) return null
      if (choice === PREVIOUS_LABEL) return 'previous'
      if (choice === NEXT_LABEL) return 'next'
      const index = choices.indexOf(choice)
      if (index === allOptions.length) return { answer: selectedLabels(allOptions, checked), wasCustom: false }
      if (index >= 0 && index < allOptions.length) checked[index] = !checked[index]
    }
  }

  while (true) {
    const labels = allOptions.map((option, i) => option.isOther
      ? `${i + 1}. Other… — press Enter to type`
      : `${i + 1}. ${option.label}`)
    if (canGoBack) labels.push(PREVIOUS_LABEL)
    if (canGoForward) labels.push(NEXT_LABEL)
    const choice = await ctx.ui.select(title, labels)
    if (choice === undefined) return null
    if (choice === PREVIOUS_LABEL) return 'previous'
    if (choice === NEXT_LABEL) return 'next'
    const index = labels.indexOf(choice)
    const chosen = allOptions[index]
    if (chosen?.isOther === true) {
      while (true) {
        const typed = await ctx.ui.input(params.question, customText ? `Current answer: ${customText}` : 'Your answer')
        if (typed === undefined) break
        const trimmed = typed.trim()
        if (trimmed) return { answer: trimmed, wasCustom: true }
        if (customText) return { answer: customText, wasCustom: true }
      }
      continue
    }
    const answer = chosen?.label ?? choice
    return { answer, wasCustom: false, index: index + 1 }
  }
}
