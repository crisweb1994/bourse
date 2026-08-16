# Changelog

## [0.10.0](https://github.com/crisweb1994/bourse/compare/v0.9.0...v0.10.0) (2026-08-16)


### Features

* **visualization:** 研究报告图表体系 — 价格结构图 / 信号矩阵 / PE 分位带 / 情景区间 / 风险矩阵，及证据数据管线 ([851aa9c](https://github.com/crisweb1994/bourse/commit/851aa9c9949f9ed5c9d7e69c66490e309dfdfac9))
* **visualization:** 补齐全部剩余图表 C7-C14（PRD S4+P1） ([150e2e5](https://github.com/crisweb1994/bourse/commit/150e2e5545b4294bd4df67fd4e950a976ee49d81))
* **web:** simplify analysis presentation ([85d70b6](https://github.com/crisweb1994/bourse/commit/85d70b67e012c2db64b5911c6fbee44d60855daf))


### Bug Fixes

* fix something ([04909c2](https://github.com/crisweb1994/bourse/commit/04909c21624935b12a9760a79d2af03a395131fb))
* **snapshot:** 单请求双窗口取历史 — 修复并发估值请求触发同源限流 ([9eee7cc](https://github.com/crisweb1994/bourse/commit/9eee7cc1a871337d2af029a53fc126ba7b97dd3a))
* **typecheck:** narrow optional market data tool runner ([7e98403](https://github.com/crisweb1994/bourse/commit/7e984036e0be9c713c5490120e506ee900b064b5))
* **watchlist:** sparkline hook 依赖数组稳定性 — 修复 Maximum update depth exceeded ([4fd2293](https://github.com/crisweb1994/bourse/commit/4fd22930a2ea4d2ff1efcbc36487dfcafee51c6e))

## [0.9.0](https://github.com/crisweb1994/bourse/compare/v0.8.0...v0.9.0) (2026-08-15)


### Features

* **analysis:** replace legacy research with v2 five-module workflow ([4bcbaf2](https://github.com/crisweb1994/bourse/commit/4bcbaf273228b1a896fc7c242524c6bce85bdc9f))
* **analysis:** 用五模块研究流程替换旧版九维分析 ([da3351e](https://github.com/crisweb1994/bourse/commit/da3351e5d3d27dfd46b5a1d8e29eb10ee0e21d13))


### Bug Fixes

* **analysis:** harden v2 streaming and recovery ([c992ade](https://github.com/crisweb1994/bourse/commit/c992ade63350a77a91bb8996dec0c994c7f32abe))

## [0.8.0](https://github.com/crisweb1994/bourse/compare/v0.7.0...v0.8.0) (2026-08-08)


### Features

* **stock:** enrich header into a research summary ([bf89a95](https://github.com/crisweb1994/bourse/commit/bf89a950280d380227fec95bbe649a51cb67d306))


### Bug Fixes

* use provider-first earnings facts ([fdc1ba2](https://github.com/crisweb1994/bourse/commit/fdc1ba22bc92b5f6dbef04fe08bc97883a879640))

## [0.7.0](https://github.com/crisweb1994/bourse/compare/v0.6.0...v0.7.0) (2026-08-02)


### Features

* **analysis:** split narrative-only extraction schema from core actuals ([61704a8](https://github.com/crisweb1994/bourse/commit/61704a8e3641e3247e02b4397750f63e4478e2f9))
* **api:** add earnings v2 orchestrator and switch generation to structured-first runner ([43c3fef](https://github.com/crisweb1994/bourse/commit/43c3fef8de569863d4186d04d8b0ba4efba451a2))
* **api:** add earnings v2 runner core — structured lane orchestration ([f93140e](https://github.com/crisweb1994/bourse/commit/f93140ec2fd547f5d3e28807be169eb218a12b85))
* **api:** add structured selection persistence service ([6076cc6](https://github.com/crisweb1994/bourse/commit/6076cc638709bf2e161ca559f6c747971bef68dd))
* **api:** add v2 earnings card assembly (selection status -&gt; dataStatus, non-GAAP merge) ([02afc5b](https://github.com/crisweb1994/bourse/commit/02afc5b5419f8881a3b6e92e5edd08a641e8c247))
* **earnings:** add financials-v2 contract and event-aware exact-period selector ([75ec253](https://github.com/crisweb1994/bourse/commit/75ec253d9e46f7913fa9d8702682b82b6e9ca291))
* **earnings:** add structured-first persistence models and card dataStatus contract ([b1ac7b2](https://github.com/crisweb1994/bourse/commit/b1ac7b23a5091e1151bc0ffc1c7d235142ef9501))
* **earnings:** surface dataStatus, non-GAAP and v2 provenance through the API DTO ([7bc25e9](https://github.com/crisweb1994/bourse/commit/7bc25e92ee12db8a84bef7bfe9d1c173bb1d2f3e))
* **earnings:** 财报数字结构化优先（structured-first）双通道改造 ([73e60f0](https://github.com/crisweb1994/bourse/commit/73e60f0a3af657d38431f3315158cc095f74364c))
* **market-data:** add Eastmoney CN v2 connector emitting financials-v2 bundles (local research only) ([22bfbe0](https://github.com/crisweb1994/bourse/commit/22bfbe01146e07247e80020fd4edf1d1fc7c3c57))
* **market-data:** add Eastmoney HK v2 connector emitting financials-v2 bundles ([e483a80](https://github.com/crisweb1994/bourse/commit/e483a80046e94cfd5c3e5b2785430d121539ebab))
* **market-data:** add SEC EDGAR v2 connector emitting financials-v2 bundles ([330d366](https://github.com/crisweb1994/bourse/commit/330d3665243cdb9a91f5e3cdf8bc587983b06345))
* **web:** render structured-first earnings states, provenance and non-GAAP ([0ae8ce6](https://github.com/crisweb1994/bourse/commit/0ae8ce647ab5a809be878dcd00547f5e174b5ea8))


### Bug Fixes

* **analysis:** support HK Q1 results announcements in the selector ([871fc95](https://github.com/crisweb1994/bourse/commit/871fc95de7dcffab53f873ade54f065472fe9940))
* **api:** derive earnings period identity from filing titles (docs §10 rule 3) ([8500077](https://github.com/crisweb1994/bourse/commit/8500077e6d2aa2db0cc19038942c38d678eecf15))
* **api:** normalize null filing language/title in v2 card payload ([33ec37e](https://github.com/crisweb1994/bourse/commit/33ec37ebd34067d2041fa4cabe4de6bcdce9f777))
* **api:** parse annual results-announcement titles and day-first dates ([cc1881d](https://github.com/crisweb1994/bourse/commit/cc1881dfa3763890398bc5d76c58fe0dc2c3e59b))
* **api:** parse HK results-announcement titles for period identity ([675b023](https://github.com/crisweb1994/bourse/commit/675b02387e07013f6eb920ab4852f6866d2e9347))
* **earnings:** explain OTC/ADR tickers without SEC filings instead of raw SEC errors ([84663d7](https://github.com/crisweb1994/bourse/commit/84663d7f5c16e0af03b48153e4c26477eb7ec9be))
* **market-data:** exclude 10-Q/10-K comparative columns and fix fiscal-year-start inference ([4291bd5](https://github.com/crisweb1994/bourse/commit/4291bd58d95f7fab65472031a46415cf0123840b))
* **market-data:** narrow derivation unions in connector tests ([269cc82](https://github.com/crisweb1994/bourse/commit/269cc82e9832bff06eb45457dbe08dcc19f2b8cb))
* **market-data:** rank primary listings above OTC ADRs in instrument search ([4bf8c8f](https://github.com/crisweb1994/bourse/commit/4bf8c8fa0e1559208388f7663f174b3cbd8c2252))

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
