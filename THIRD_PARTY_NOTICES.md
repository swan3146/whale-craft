# 第三方组件与许可（THIRD PARTY NOTICES）

whale_craft 自身以 **MIT** 发布（见 `LICENSE`）。它**不打包**任何第三方代码，只在运行时
`import` 下列组件；请按各自许可使用与分发。

## 运行时依赖

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [`mineflayer`](https://github.com/PrismarineJS/mineflayer) | MIT | 无头 Minecraft 机器人 API。**由部署方安装**（见 README「关于 mineflayer」） |
| [`minecraft-protocol`](https://github.com/PrismarineJS/node-minecraft-protocol) | MIT | 协议层（mineflayer 的依赖） |
| [`minecraft-data`](https://github.com/PrismarineJS/minecraft-data) | MIT | 方块/实体/协议数据（mineflayer 的依赖） |
| `prismarine-*`（block / chunk / entity / item / physics / registry / windows / world 等） | MIT | mineflayer 的一组依赖 |
| [`vec3`](https://github.com/PrismarineJS/vec3) | MIT | 坐标向量类 |

## 宿主（DSH）提供的包

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| `@deepseek-ai/dsh-tools` | MIT | 工具注册契约（`defineTool`）——由宿主提供，不随本包分发 |
| `@deepseek-ai/schemastery` | MIT | 插件配置 schema——由宿主提供 |

## 可选

| 组件 | 许可 | 说明 |
| --- | --- | --- |
| [`sharp`](https://github.com/lovell/sharp) | Apache-2.0 | **可选**：`mc_kit_image` 的 SVG→PNG 光栅化。没装也能用（地图出图走自带零依赖 PNG 编码器；`mc_kit_image` 会明确报"图像引擎不可用"） |

> 本包内的 `src/png.mjs` 是**自己写的零依赖 PNG 编码器**（`node:zlib` + 手写 CRC32），
> 不引用任何第三方图像库。
