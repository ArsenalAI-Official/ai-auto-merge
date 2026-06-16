# Changelog

## [1.1.0](https://github.com/manikyashetty-arch/ai-auto-merge/compare/v1.0.0...v1.1.0) (2026-06-16)


### Features

* adaptive learning loop, notifications, and professional README ([134dd76](https://github.com/manikyashetty-arch/ai-auto-merge/commit/134dd76ba6312342954f03a8385dfdf8025bdbbe))
* **config:** support GITHUB_PRIVATE_KEY_PATH; add setup guide ([dbe97c0](https://github.com/manikyashetty-arch/ai-auto-merge/commit/dbe97c07ee58dbd0612d6340f7194902459a6ef4))
* multi-provider LLM support (Anthropic + OpenAI) and live e2e harnesses ([ab78108](https://github.com/manikyashetty-arch/ai-auto-merge/commit/ab78108a00e95fb65cc48560782d3ac7a91611da))
* **security:** harden against malicious PRs, injection, and misconfig ([b5eaaa3](https://github.com/manikyashetty-arch/ai-auto-merge/commit/b5eaaa335ac94c392ba08d636366d257b08a17ed))
* sequential PR resolution by default + keep-both override guard ([682e8a4](https://github.com/manikyashetty-arch/ai-auto-merge/commit/682e8a4fa0c260f9fedf71a2ec5c2c10dd725418))


### Bug Fixes

* correctness + safety edge cases found in multi-agent audit ([d454743](https://github.com/manikyashetty-arch/ai-auto-merge/commit/d4547436d048b678604399829d41efa818a3dd4b))
* harden resolution against truncation, binary, empty, races, and log leaks ([65e1847](https://github.com/manikyashetty-arch/ai-auto-merge/commit/65e1847586705ee2aa512ee4cd45cc8dca91219e))
* REST-enabled installation client and correct git-over-HTTPS auth ([4761d1b](https://github.com/manikyashetty-arch/ai-auto-merge/commit/4761d1b775c31350e378ec4e9bf85a44cc530869))


### Performance

* adaptive resolution pipeline cuts token spend ~2x on the common case ([2e8325b](https://github.com/manikyashetty-arch/ai-auto-merge/commit/2e8325bd79acc7e6866ca7e5546e24c07086297e))
