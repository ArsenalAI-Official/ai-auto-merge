# Tests

Jest + `ts-jest`. Tests live alongside the source they cover and follow `*.test.ts` naming.

```bash
npm test                    # run the full suite
npx jest --coverage         # with coverage report
npx jest path/to/file.test  # run a single suite
```

## Layout

| File | Covers |
|---|---|
| `conflictClassifier.test.ts` | additive / import / complex / delete conflict heuristics |
| `conflictResolver.test.ts` | fast-paths + Claude-mocked complex resolution pipeline |
| `prProcessor.test.ts` | confidence-threshold logic |
| `server.test.ts` | Express routes (with mocked GitHub service) |
| `syntaxCheck.test.ts` | conflict marker detection + TS/JS syntax validation |
| `logger.test.ts` | winston logger smoke tests |
| `queueFlag.test.ts` | `isQueueEnabled()` toggling on `REDIS_URL` |
| `__mocks__/config.ts` | auto-mocked config module (constant test env) |
| `setup.ts` | sets fake env vars before any module loads |

## Conventions

- **Never call real APIs.** GitHub and Anthropic are mocked. If a new test needs an HTTP call, mock it.
- **Pure functions first.** New utility code should ship with a small unit test in this directory.
- **No order dependencies.** Each test should set up and tear down its own state. Use `beforeEach` / `afterEach` for env-var mutations and call `jest.resetModules()` when mutating env vars that modules read at import time.
- **Mock at the boundary.** Use `tests/__mocks__/` to keep test setups identical across files.
