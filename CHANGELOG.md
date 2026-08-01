# Changelog

## [0.6.0](https://github.com/crisweb1994/bourse/compare/v0.5.0...v0.6.0) (2026-08-01)


### Features

* add capability-routed market data client ([4cb4b99](https://github.com/crisweb1994/bourse/commit/4cb4b99ba23d260e89ca4fa0a6ea9287084ad573))
* complete market data v2 routing ([c0c616f](https://github.com/crisweb1994/bourse/commit/c0c616f66f4182b66ef1829ed9df08d396ef74a8))
* integrate capability-routed market data sources ([5f8116b](https://github.com/crisweb1994/bourse/commit/5f8116bcc58a6006ccbf7660e598b5998ef532b8))


### Bug Fixes

* build market-data before analysis in Docker ([2215c2a](https://github.com/crisweb1994/bourse/commit/2215c2ac87d0ed19982fdeb1f3f632523a0233af))
* improve HK evidence pack coverage ([ada2cfb](https://github.com/crisweb1994/bourse/commit/ada2cfbf47b12f82b3b81d0e958bee26dbf8a188))
* narrow earnings check status in test ([a21f522](https://github.com/crisweb1994/bourse/commit/a21f522a1af605f7b82d65b86a37d923fc925a37))
* normalize earnings extraction metadata ([e306a20](https://github.com/crisweb1994/bourse/commit/e306a2022bb562a2c2b1b12dd09a10fc88db766a))
* preserve holdings and harden derived data routing ([f1cb36f](https://github.com/crisweb1994/bourse/commit/f1cb36f5bc6e5c9b540bc17102c57e8840f28762))
* recover HK quotes and earnings briefs ([b343075](https://github.com/crisweb1994/bourse/commit/b3430753c469594000ef09b141006f253eb6c852))
* support foreign issuer earnings filings ([e151409](https://github.com/crisweb1994/bourse/commit/e151409917a61b09de144197256a4baafcb004a5))
* 修复多市场数据路由、财报解析与异步生成链路 ([13c9ec5](https://github.com/crisweb1994/bourse/commit/13c9ec539e116f4b946c15aff6c8286dadd99a8d))

## [0.5.0](https://github.com/crisweb1994/bourse/compare/v0.4.0...v0.5.0) (2026-07-28)


### Features

* extract market data package and add provider fallbacks ([4b9f767](https://github.com/crisweb1994/bourse/commit/4b9f7673e97f11b84937d6b8ea303c3ef0bdde39))
* extract market data package and add provider fallbacks ([cd2aa34](https://github.com/crisweb1994/bourse/commit/cd2aa344e8321d224f9a6f5871e08d4cd992e2aa))


### Bug Fixes

* repair stock resolution and citation validation ([2fe66de](https://github.com/crisweb1994/bourse/commit/2fe66debd32326f216c0d18d40a134856d05158e))

## [0.4.0](https://github.com/crisweb1994/bourse/compare/v0.3.0...v0.4.0) (2026-07-27)


### Features

* **analysis:** strengthen research data coverage and fallbacks ([9e0f96e](https://github.com/crisweb1994/bourse/commit/9e0f96eeaefd22c1e05a3991d7c5be2ee549f767))
* 完善研究数据覆盖与 US/HK 行情降级能力 ([6f0db33](https://github.com/crisweb1994/bourse/commit/6f0db33b824f1e4dab2a03d1f6c928100b7a9d58))

## [0.3.0](https://github.com/crisweb1994/bourse/compare/v0.2.0...v0.3.0) (2026-07-26)


### Features

* **analysis:** real abort + per-run token visibility ([53a3740](https://github.com/crisweb1994/bourse/commit/53a3740757f948c64379e77740a5cd36bcd204ee))


### Bug Fixes

* **analysis:** close abort race, web-search cap gaps, cancel UI state ([22448e9](https://github.com/crisweb1994/bourse/commit/22448e9e7e9df09ffefcbffc02c92c4c7619d9c1))

## [0.2.0](https://github.com/crisweb1994/bourse/compare/v0.1.0...v0.2.0) (2026-07-25)


### Features

* add earnings brief workflow ([1a9d9bd](https://github.com/crisweb1994/bourse/commit/1a9d9bdc585ae47f90ca90782a9a7881b7cb62c3))
* **earnings:** add phase 3 with oss simplification ([1460e94](https://github.com/crisweb1994/bourse/commit/1460e945beab3dc6799ce5872b8ba8688bd904e1))
* **earnings:** 新增财报速读 Phase 3 ([ae6c469](https://github.com/crisweb1994/bourse/commit/ae6c46990362ba2e7a6e0db80aac590db13145d7))


### Bug Fixes

* **earnings:** harden functional acceptance paths ([5724b89](https://github.com/crisweb1994/bourse/commit/5724b89b941e090d36da116c96f8c1092b23f237))
* harden earnings functional workflows ([54caff0](https://github.com/crisweb1994/bourse/commit/54caff07335bd25f81c6371c14f04be3b8e1fc8e))

## [0.1.0](https://github.com/crisweb1994/bourse/compare/v0.0.1...v0.1.0) (2026-07-19)


### Features

* **chat:** add evidence-grounded stock research chat ([9ca12c7](https://github.com/crisweb1994/bourse/commit/9ca12c7e80897bcb238b611c9612a4ed8c08eadb))
* **digest:** Daily Brief 子系统 task1-5（订阅 CRUD + 指数层 + Brief Generator） ([50de0b5](https://github.com/crisweb1994/bourse/commit/50de0b56e967c9a26ce5ba01fff173e1a7390e13))
* **digest:** Daily Brief 子系统（定时行情简报 · Phase A） ([4b9f1b6](https://github.com/crisweb1994/bourse/commit/4b9f1b6bdda5dd3d2a0633701d01ae1df2f673d0))
* **digest:** task6 推送层（ChannelAdapter + 投递编排） ([4704765](https://github.com/crisweb1994/bourse/commit/470476512d9cf288131a40393c774e3f8f59f1f6))
* **digest:** task7 触发层 + 真实投递 bug 修复（trigger/窗口/幂等 + TG/飞书） ([547910a](https://github.com/crisweb1994/bourse/commit/547910ac2be2df5d8925df6529dcbf3daefd1b7d))
* **digest:** 内置 heartbeat 调度（单副本，替代外部 cron） ([41ed8d9](https://github.com/crisweb1994/bourse/commit/41ed8d9911425ae4b5f53e7831649f096d65f66e))
* **digest:** 内置 heartbeat 调度（单副本，替代外部 cron） ([8f1b8b7](https://github.com/crisweb1994/bourse/commit/8f1b8b7b93a51051128ba055b5b25d6633a245a3))
* **digest:** 前端订阅配置 UI + 修真实 Nest DI 的 deps 注入 bug ([f31ecc9](https://github.com/crisweb1994/bourse/commit/f31ecc9bbd80ad7317bfb13a843d847032180562))
* finish chat ([c489160](https://github.com/crisweb1994/bourse/commit/c489160b9f839e68669c951ed9d5b253db3d2220))
* remove model ([3a80554](https://github.com/crisweb1994/bourse/commit/3a805544c2aa4ce58aef8adee5e4086a478eafd2))
* **settings:** split AI configuration pages ([e1d0d60](https://github.com/crisweb1994/bourse/commit/e1d0d60d0f5c0ced4e0fe0805bff8ea970532f08))
* **settings:** split AI configuration pages ([622527b](https://github.com/crisweb1994/bourse/commit/622527b5ccfe20b776ca4e8d547d917ad39e166e))
* update ([b76dfc9](https://github.com/crisweb1994/bourse/commit/b76dfc907c9e2e0ccf152b0bede0d7cb18884f61))
* update ([9199a4b](https://github.com/crisweb1994/bourse/commit/9199a4b2bc28054f5518dec9789a60a7805cc8c4))


### Bug Fixes

* add dependency for typecheck task ([b3b8b76](https://github.com/crisweb1994/bourse/commit/b3b8b764c5ed1a4543d1d7738f7eb152bc295176))
* **analysis:** 删 4 个引用已删除 API/model 的死脚本 + 修尾部空行 ([091321a](https://github.com/crisweb1994/bourse/commit/091321a2880878e4b8cd0adc7a06c0798fcc90d0))
* fix docker ([8fd269a](https://github.com/crisweb1994/bourse/commit/8fd269a29443e4ef60365c5e6151bf067c1ba7e5))
* **web:** allow Docker builds without root env file ([ec2c093](https://github.com/crisweb1994/bourse/commit/ec2c09323a1a5aef293490f9f83dc65779b14212))
