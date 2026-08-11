# Third-Party Notices

本项目（RPG Maker LAN Library）的代码以 MIT 许可证发布（见 [LICENSE](LICENSE)）。
以下第三方组件以独立许可证随项目分发，请在使用/再分发时遵守其各自条款。

## Kirikiroid2 Web（KRKR 运行时）

- 位置：`public/krkr-runtime/`
- 说明：KiriKiri 2 / Kirikiri2 引擎的 WebAssembly 移植，用于在浏览器中运行 `data.xp3` 游戏。
- 来源：https://github.com/fenghengzhi/krkr2 （krkrsdl2-web 构建产物）
- 许可证：见 `public/krkr-runtime/KRKR2-LICENSE.txt`（BSD 风格，含 W.Dee 及 KiriKiri Z 项目贡献者版权声明）
- 构建产物内另含第三方 JS 库（jszip 等），按其各自许可证分发。

## mkxp-z（RGSS 运行时）

- 位置：`public/mkxp/`
- 说明：RPG Maker VX Ace（RGSS3）的开源运行时 mkxp-z 的 WebAssembly 编译产物，由项目所有者自行编译。
- 来源：https://github.com/mkxp-z/mkxp-z
- 许可证：**GPL-2.0**。mkxp-z 以 GNU General Public License v2 发布；本目录中的 WebAssembly 二进制为 GPL 代码的编译产物，再分发必须遵守 GPL-2.0 条款（提供对应源码/构建方式或遵守 GPL 义务）。
- 项目所有者的 mkxp-z 构建配置与源码构建记录不随本仓库分发；如需源码，请联系项目维护者或从上游构建。

## RGSS 兼容脚本

- 位置：`public/rgss-compat/`
- 说明：针对特定 RGSS 游戏的响应层兼容脚本（Ruby，注入到 RGSS 运行时加载链）。
- 许可证：与项目本体一致，MIT。

## 运行时与主程序的关系

上述运行时以"独立作品"形式随本项目分发，不改变项目主代码的 MIT 许可；反之亦然。
