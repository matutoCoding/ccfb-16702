# 文保 RTI Studio · 浏览器端 RTI 拟合与重光照

TypeScript + WebGPU + IndexedDB 实现的多光源反射变换成像(RTI)系统。
拟合与重光照均使用 WGSL 计算/渲染着色器,数据全部保存在浏览器本地,不上传文物影像。

面向钱币、印章、甲骨、铜镜等器物的圆顶多灯拍摄场景。

---

## 快速开始

```bash
npm install
npm run dev        # http://127.0.0.1:5173
```

使用最新版 **Chrome / Edge**(需支持 WebGPU;地址栏 `chrome://gpu` 可确认硬件加速)。

内置合成测试数据,无需准备照片:

1. 打开「拍摄批次」→ 点击 **✨ 生成合成样例 (1280²·48灯)** 或 **🎯 生成验收数据 (2000²·48灯)**。
2. 进入「拟合任务」→ 选择 PTM 或 HSH → 创建并开始拟合(可暂停/关页面后继续)。
3. 拟合完成后点「查看重光照」,在画面或灯位盘上拖动光源。

也可以「📥 导入 JPG / PNG」使用真实拍摄组。

---

## 功能与页面

| 页面 | 对应需求 |
| --- | --- |
| **拍摄批次** | 导入几十张 JPG/PNG;多尺度灰度/Sobel 金字塔平移对齐;基于灯位回归的曝光不一致检测(EV 提示);拖拽导入;批次卡片 |
| **灯位标定** | 从黑色反光球自动检测球体与高光质心并反算光源方向;高光点/球心/半径均可鼠标拖动修正;48 灯极坐标覆盖图 |
| **拟合任务** | **PTM 二次多项式(每通道 6 系数 / 共 18)** 与 **半球谐 HSH 二阶(每通道 9 / 共 27)**;WebGPU 逐像素、按 tile 分块进后台队列;每块落 IndexedDB,**关闭页面后已算块不重算,可断点续算** |
| **重光照查看** | 拖动光源实时重光照;**镜面增强、法线可视化、最多 4 光源合成、浮雕线稿、刻痕深浅配色**;导出当前画面 PNG、法线图 |
| **测量标注** | 比例尺卡标定 mm/像素;长度、刻痕宽度、点、文字备注;端点可拖拽修正;标注带**作者与 ISO 时间**;JSON/CSV/叠加 PNG 导出 |
| **两期对比** | 同器物两个时间点照片自动对齐;颜色差 + 橙/绿锈蚀指数检测变化区域;形态学去噪、连通域编号、面积(mm²);分屏拖动;保存对比记录与报告 |
| **设置验收** | 作者/单位/分块/主题;WebGPU 信息;**一键浏览器精度验收与 2000²×48 性能基准**;IndexedDB 用量与清空 |

---

## 验收结果

### 拟合精度(合成真值法线对比)

合成器用带「文保 / RTI / 印」刻字与 50+ 凹坑的高度场,按已知穹顶灯位渲染 48 张图
(Lambert 漫反射 + Blinn-Phong 高光 + 铜绿反照率 + 噪声,其中第 5、31 张故意做曝光偏差)。

Node 参考实现(与 GPU 共用同一份最小二乘投影矩阵和稳健法线算法):

```bash
npm run accept            # 默认 720²,可 npx tsx scripts/acceptance.ts --size 560
```

实测(560²×48):

```
PTM 法线(干净):      平均 1.162°  中位 0.725°  P95 3.45°
HSH 法线(干净):      平均 1.162°(法线由同一稳健光度流程给出)
曝光异常+校正:        平均 1.182°
```

**平均角度误差 < 3°,达标。** 浏览器内「设置 → 拟合精度验收」走真实多 tile GPU 路径,
512²×48 实测平均约 **1.08°**,GPU 计算约 **0.29 s**;GPU 与 CPU 系数最大绝对误差 ~2e-7。

### 性能(2000×2000、48 张)

在 NVIDIA RTX 3060 上:

- 设置页纯拟合基准(64 tile 的 write/dispatch/readback + u8 量化):**约 2.4 s**(其中 GPU ~1.1 s、量化 ~1.2 s)。
- **真实端到端拟合队列**:48 张 JPEG 解码 + 对齐采样打包 + GPU + 量化 + IndexedDB 落盘,墙钟 **约 6.4 s**(计算口径 4.27 s)。

**页面拟合完成远低于 20 s,达标。** 合成 2000² 测试图像本身约 35 s(仅数据准备,不计入拟合)。

---

## 数学与渲染要点

- 坐标约定:图像像素 x 右、y **下**;光照世界系 x 右、y **上**、z 指向观察者。
  球高光反算时对 y 取负。
- 基函数:
  - PTM:`[u², v², uv, u, v, 1]`,与标准 PTM 磁盘项序一致。
  - HSH:Relight/CHI 标准二阶 9 基的无奇点笛卡尔形式
    (`sz = sqrt(lz/(1+lz))`),与外部 `.rti` 系数配对一致。
- 拟合:灯位矩阵 `A(m×k)` → 投影 `P = (AᵀA)⁻¹Aᵀ`(`k×m`),逐像素 `c = P·I`。
  CPU(`src/core/math`,`src/core/fit/cpuFit.ts`)与 WGSL(`src/gpu/fitShader.ts`)使用同一 `P`。
- **稳健法线**:线性光亮度上 `[lx,ly,lz,1]` 初值 + 4 轮非对称截断 IRLS
  (镜面/过曝产生的正残差加倍惩罚,保留 70% 内点,叠加 `n·l` 可见性权重压制背光截断),
  解 4×4 正规方程。这是平均误差能稳定在 ~1° 的关键。
- 模型系数在 **gamma 域**拟合(与传统 PTM 和外部查看器一致),法线在 **linear 光域**拟合。
- 系数按 tile、按系数维 min/max 量化为 u8 存 IndexedDB;查看器反量化并在片元着色器实时求值。
- 深度图由法线梯度做多方向扫描积分融合(`src/core/result/depthMap.ts`),仅用于线稿/深浅配色。

---

## 数据与断点续算

IndexedDB 库名 `rti-studio`,对象仓库:
`batches / images(Blob) / jobs / results / chunks / annotations / comparisons / kv`。

- 每个 tile 完成后:u8 系数块、法线块写入 `chunks`,`job.doneTiles` 与 `result.tileMin/Max` 同步落盘。
- 再次开始时跳过 `doneTiles`;应用启动/任务页会把上次异常退出残留的 `running` 置为 `paused`。

---

## 标准文件导出

在重光照页右侧「导出」:

- **`.ptm`(PTM_FORMAT_RGB 1.2)**:ASCII 头
  `PTM_1.2 / PTM_FORMAT_RGB / w / h / 6 个 float scale / 6 个整数 bias`,
  随后三个通道块(R/G/B),每块 `w·h·6` 字节,**自下而上的扫描行**,项序 `[u²,v²,uv,u,v,1]`,
  总 18 字节/像素。可被 CHI RTIViewer、Relight 直接打开。
- **`.rti`(`#HSH1.2` universal HSH)**:头 `#HSH1.2 / 3 / w h 3 / 9 2 1`,
  两个 9 项小端 float32 数组(scale、min/255),随后自上而下、通道块顺序的 27 字节/像素。
  该容器的 float 语义在 Relight 与 CHI 资料间存在歧义,已按 Relight `saveUniversal` 字节级实现;
  若个别旧查看器不识别,优先使用 `.ptm`。
- 标注 JSON/CSV、叠加 PNG、对比报告均在对应页面导出。

导出字节布局有 Node 往返校验:

```bash
npm run check:modules   # export / alignment / sphere / rust 四个自测
```

---

## 目录结构

```
src/
  core/
    types.ts            # 全部记录/契约类型
    db.ts               # IndexedDB 封装 + chunks/kv
    math/               # 伪逆、基函数(PTM/HSH)
    synth/              # 高度场、刻字笔画、穹顶灯、CPU 渲染器、demo 批次
    image/              # 曝光检测、平移对齐(子代理模块)
    calib/sphereDetect.ts
    fit/                # CPU 参考拟合 + 稳健 IRLS 法线
    result/             # 分块读取、深度积分
    export/exporters.ts # PTM / RTI
    analysis/rustCompare.ts
  gpu/
    device.ts           # WebGPU 单例
    fitShader.ts        # 拟合 compute(含 WGSL IRLS)
    gpuFitter.ts        # 单 tile 拟合器
    tilePacker.ts       # 解码图 -> light-major u32 tile(含对齐/clamp)
    fitQueue.ts         # 分块队列 + IndexedDB 断点续算
    relightShader.ts    # 重光照片元(6 种模式)
    relightRenderer.ts
    benchmark.ts        # 浏览器精度/2000 性能基准
  ui/pages/             # 七个页面
  ui/annotation/        # 标注 SVG/弹窗/导出
  ui/compare/           # 对比页对齐
scripts/                # Node 验收与各模块字节/算法自测
```

## 已知边界

- 需要 WebGPU;无 WebGPU 的环境会在顶栏与设置页明确提示。
- 浏览器 IndexedDB 配额通常为磁盘可用空间的一定比例;2000² 一组(原图 + 系数块)约数百 MB。
- 自动对齐为平移模型(RTI 机位通常固定);未做旋转/透视。
- HSH `.rti` 的跨查看器兼容性以 Relight 为准,PTM 是兼容性最稳的导出。
