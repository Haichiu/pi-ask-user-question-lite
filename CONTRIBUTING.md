# Contributing to pi-ask-user-question-lite

Thanks for helping improve this tool! This is a small, focused package: one model-callable tool (`AskUserQuestion`) for the [Pi coding agent](https://github.com/badlogic/pi-mono), with three renderers that must stay behaviorally identical: TUI, RPC, and headless JSON/print.

## Getting started

```sh
git clone https://github.com/haichiu/pi-ask-user-question-lite.git
cd pi-ask-user-question-lite
npm ci
npm test        # vitest suite in tests/
```

## Ground rules

- **Scope discipline**: this package registers exactly one tool and bundles no skill, workflow, or system-prompt policy. Proposals that add a second concern will be asked to live in a separate package.
- **Renderer parity**: any behavior change must work the same way in TUI, RPC, and headless fallback. Add or update a test for each affected renderer.
- **No response timeouts**: the tool never gives up on a human answer. Do not introduce auto-dismiss or deadline logic.
- **TypeScript strictness**: keep `tsconfig.json` strict and the public types in `extensions/index.ts` stable; additive changes only unless discussed.
- **Dependencies**: avoid adding runtime dependencies.

## Submitting changes

1. Open an issue first for anything beyond small fixes, so we can agree on scope.
2. Create a feature branch from `main`.
3. Add tests that fail without your change and pass with it.
4. Run `npm test` and make sure the suite is green.
5. Open a pull request with a short description of the behavior change and which renderers it touches.

## Reporting bugs

Please use the bug report template and include: Pi version, install method (`pi install npm:...` vs `git:`), interface in use (TUI / RPC / headless), and the exact tool call input plus observed output.

## License

By contributing, you agree that your contributions are licensed under the MIT License of this repository.
