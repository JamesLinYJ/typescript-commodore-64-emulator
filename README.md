# TypeScript Commodore 64 Emulator

TypeScript Commodore 64 Emulator 是一个以严格 TypeScript、React 和 ES Modules 现代化重构的 Commodore 64 浏览器模拟器。项目目标不是只显示 BASIC 启动画面，而是让 6510、PLA 内存映射、VIC-II、两颗 MOS 6526 CIA、SID、键盘、摇杆及媒体链路都具备可验证的硬件行为。

## 开发

```bash
npm ci
npm run dev
```

完整验证：

```bash
npm run check
```

固定 PAL 核心吞吐基准（20 帧预热、120 帧采样）：

```bash
npm run benchmark:emulation
```

输出包含 p50/p95/p99 帧耗时、模拟 CPU MHz 与相对 PAL 实时倍率。浏览器界面另显示
120 帧滚动窗口的呈现 FPS、p95 帧耗时和超出 19.95 ms PAL 预算的帧数；两组数据分别
衡量核心吞吐与宿主呈现，避免把显示刷新率误当成模拟器峰值性能。

真实程序负载基准会校验三份固件和内置 Voidrunner PRG 的 SHA-256，从 BASIC 启动程序，
再让三声部 MOS 6581 波形经过活动滤波器并逐帧排出音频样本：

```bash
npm run benchmark:real
npm run benchmark:real -- --drive
```

第二种模式还会逐周期推进真实 1541-II ROM；它需要先运行一次 `npm run verify:drive`，
以取得并校验 `output/reference/1541-II.251968-03.bin`。输出包含预热/采样帧数、吞吐、
p50/p95/p99 帧耗时、PAL 实时倍率和 SID 样本数；基准只衡量整机核心，不包含 DOM/Canvas
呈现时间。

硬件外部参考门禁：

```bash
npm run verify:cpu-rdy-store
npm run verify:via
npm run verify:cartridge
npm run verify:easyflash
npm run verify:tape
npm run verify:drive
npm run verify:drive:write-protect
npm run verify:drive:disk-change
npm run verify:drive:hls
npm run verify:cia:ports
npm run verify:cia:irqnmi
npm run verify:cia:icr-rmw
npm run verify:cia:timer-cascade
npm run verify:cia:timer-icr
npm run verify:cia:timer-output
npm run verify:cia:tod
npm run verify:cia:tod-alarm
npm run verify:cia:tod-invalid
npm run verify:vic
npm run verify:vic:sprites
npm run verify:prg-autostart
npm run verify:programs
npm run verify:reference
```

`verify:cpu-rdy-store` 会从固定 commit 下载并校验 SHA-256 固定的 `shxy2.prg` 与
`shyx2.prg`，分别覆盖 SHX 和 SHY。每项程序都会从干净 BASIC 通过 `RUN`/`SYS 2062`
启动一次，再从 `$080E` 直接启动一次；两条入口都必须写入 `$D7FF=$00`、保持绿色边框，
并让 `$1080` 起的 24 字节与 6510、8500 真机结果逐字节完全一致。参考程序让精灵 DMA
恰好在指令第三、第四周期之间拉住 BA/RDY；此时第四周期读会被延长，写入数据的
`&(H+1)` 必须脱落，但跨页目标地址的高字节仍使用掩码后的值。

`verify:via` 会以项目自己的 1541 CPU 总线逐周期重放 VICE 真机采样序列，核对 MOS 6522
的 T1/PB7、T1/T2 与 IFR 行为；下载的固定版本参考数据会先校验 SHA-256，校验失败不会
降级为内部断言。

`verify:cartridge` 会下载并校验 VICE revision 46176 的固定 Ocean CRT，逐 bank 核对
ROML/ROMH 映射，并通过项目自己的 6510、PLA 和 PAL 调度路径运行卡带程序。
`verify:easyflash` 则从干净 BASIC 启动官方 EasyProg 1.6.3，让其自行识别两颗
AM29F040B 和 1 MiB 容量，再进入 EasyProg 的 Torture Test 写入路径；两侧 Flash 都必须
发生足量的真实 6510 命令序列写入，验证器不会直接修改 Flash 数据。

`verify:tape` 会生成 SHA-256 固定为
`72434c68f55b078e9cabca5e6db55273c9fbf87f98d668d93c681bb65958f731` 的标准 ROM
格式 TAP。夹具只包含 SHORT/MEDIUM/LONG 原始脉宽、双份头块、双份数据块、奇校验与
XOR 块校验；真实 KERNAL 必须经 6510 马达引脚、1530 传送机构、READ 线和 CIA1 FLAG
中断自行搜索 `CODEX TAPE`，并把 64 字节逐字节装入 `$C000`。同一 TAP 已用官方
SDL2VICE 3.9 的真实磁带自动启动路径交叉验证，VICE 显示 `FOUND CODEX TAPE`、
`LOADING` 和最终 `READY.`；常规门禁不依赖 VICE 可执行文件。

同一门禁还会运行 VICE revision 46176 的 `tap204060once.prg`。程序不调用项目内部
录音接口，而是由真实 6510 直接切换 `$01` 的 WRITE/MOTOR 引脚；1530 必须在长停顿后
录出 `256/512/768/512` 周期波形。随后真实 BASIC/KERNAL 执行
`SAVE"CODEX SAVE",1`，把固定 token 化程序写入 41,756 个物理 WRITE 脉冲；全新机器
再从生成的 TAP 执行 `LOAD"CODEX SAVE",1` 并逐字节读回。生成 TAP 的 SHA-256 固定为
`c7503b92224d157bd1ba05fa0b1c100a8ddca6c9ea679ec52a2dc517abcead02`，因此录音量化、
马达边界或序列化发生漂移时不会静默通过。

`verify:drive` 会启动固定 SHA-256 的真实 1541-II DOS ROM，把 VICE revision 46176 的
固定 D64 挂载到项目自己的磁头、GCR、VIA 和 IEC 路径，再由 C64 KERNAL 实际执行
`LOAD"$",8`、`LOAD"*",8,1` 与 `SAVE"CODEX",8`。门禁会比较目录标题、目录项、
完整 PRG 字节和 KERNAL 结束地址，并把真实写入的 GCR 磁道提交到 D64 后重新装载，
逐字节核对固定 BASIC 程序。它还会运行 VICE `drive/format/format.prg`，要求真实 DOS
完成 35 轨格式化、保存测试程序、报告成功并从新磁道恢复完全一致的 PRG；不会直接从
D64 注入文件，也不会用高层磁盘协议替代驱动器 CPU。它还会让绕过 DOS 的 VICE
`drive/writeprotect/writer.prg` 直接经 VIA2 写头运行，要求至少产生 13,326 个写字节
边沿但不能改变受保护的原始磁道或 D64。`drive/diskchange/pollwp.prg` 则由驱动器代码
持续轮询 PB4；门禁自动执行拔盘、插盘和立即换盘，并要求程序实际观察到两组完整的
写保护光电传感器脉冲。

同一门禁还会自动启动 VICE revision 46176 的
`drive/iecdelay/iec-bus-delay-auto.prg`（SHA-256
`76059467c5f86f54b8c686c73989d2cdf95b77689b364c722a7bce06d01352f7`）。它通过真实 DOS
命令通道向无挂盘的 1541-II 上传周期程序，分别测量 C64 与驱动器的 IEC
上升沿和下降沿传播。验证要求 4,000 PAL 帧内恰好一次写入 `$D7FF=$00`，
两颗 CPU 均未进入 JAM，且 1541 在每个主机总线周期结束时都没有超前或落后。可用
`npm run verify:drive:iec-delay` 单独运行这一长时时序门禁。

同一驱动器门禁还会运行 VICE `drive/hls-protection/hlstest.prg`。G64 中的 `1` 被送入
独立 UE7/UF4 读写分离电路作为磁通翻转，而不是直接当作已经解码的数据位；主轴按
300 RPM 和每条磁道的实际长度用整数相位旋转，长时间无磁通时由固定复位种子的弱磁通
状态机重新锁相。门禁分别选择轨道 17 与 18，要求驱动器 `$04C0..$04FF` 的 64 字节
SO/SYNC 时序测量与上游两张预期表逐字节完全一致。

`verify:cia:ports` 会运行固定 revision 与 SHA-256 的 VICE `ciaports.prg`，并把项目输出
与六组真实 C64 键盘端口采样向量逐字节比较。它覆盖普通按键、左右 Shift、Shift Lock
以及输出引脚相互驱动时的软件可观察结果。

`verify:cia:irqnmi` 会运行 VICE revision 46176 且 SHA-256 固定的
`irqnmi-new.prg`，逐格核对 19×19 组 CIA1 IRQ 与 CIA2 NMI 相对时序。该矩阵会同时覆盖
NMI 接管已开始的 IRQ 微序列，以及错过向量选择后必须先执行一条 handler 指令的迟到边沿。

`verify:cia:icr-rmw` 会在原版 6526 与修订版 6526A 两种模型上分别运行 revision 46176
且 SHA-256 固定的 `dd0dtest.prg`。它覆盖 CPU 对 CIA2 ICR 的普通读、索引读和
读改写访问，尤其验证旧芯片在 ICR 读后第二个写周期清除 mask 时，会撤销尚未到达 NMI
引脚的中断，但不会错误清除已经锁存的源标志或已拉低的中断引脚。

`verify:cia:timer-cascade` 会从干净 BASIC 启动固定 commit 与 SHA-256 的
`cmp-b-counts-a-old.prg` 和 `cmp-b-counts-a-new.prg`，分别对照原版 6526 与修订版
6526A/8521 真机采样。两项程序会穷举 Timer A 下溢驱动 Timer B 时 CPU 指令访问落在
级联 STEP 前后的结果；门禁要求完整比较通过、写入 `$D7FF=$00` 并保持绿色边框。

`verify:cia:timer-icr` 会运行固定 commit 与 SHA-256 的 `cia-timer-oldcias.prg` 和
`cia-timer-newcias.prg`，分别对照原版 6526 与修订版 6526A 的 1 KiB 真机采样。
两项程序覆盖 CIA1/2 的 Timer A/B，在中断屏蔽和启用状态下逐周期读取 ICR；其中旧芯片
必须把 ICR 读取后紧邻的 Timer B 下溢碰撞保持到下一次 ICR 读取。完整采样一致后才允许
写入 `$D7FF=$00` 并保持绿色边框。

`verify:cia:timer-output` 会在两种 CIA 模型上运行 revision 46176 且 SHA-256 固定的
`pb6pb7/main.prg`。程序把 Port B 配成输入，分别要求 PBON 开启时停止的 Timer A/B
把 PB6/PB7 驱动为低电平、PBON 关闭后恢复为外部高电平；门禁同时核对 `$D7FF`、边框色
以及屏幕中的 `$3F/$FF` 实际引脚采样。

`verify:cia:tod` 会从干净 BASIC 启动 revision 46176 且 SHA-256 分别固定的
`hzsync0.prg` 至 `hzsync6.prg`。七个程序连续采样 256 次 CIA2 TOD，分别验证停表后重启
会复位内部六相分频器，而运行中写十分之一秒、秒、分钟不会误复位，并覆盖从 50 Hz
切到 60 Hz 以及从 60 Hz 的终态切回 50 Hz 时必须空绕一圈的相位行为；
每项都必须写入 `$D7FF=$00`、保持绿色边框，并且全部屏幕采样落在真机允许的相邻帧值内。
同一门禁还会运行固定 commit 与 SHA-256 的 `fix-tsec.prg`，在原版 6526 和修订版 6526A
上分别通过 BASIC `SYS2061` 与 `$080D` 直接入口验证全部 24 组真机结果。十分之一秒、秒、
分钟和小时中的每个 BCD 位都是独立二进制计数器：非法 A-F 会继续递增并自然回零，只有
直接命中该位的十进制终值才进位。`verify:cia:tod-invalid` 可单独运行这四组定向门禁。
固定 commit 与 SHA-256 的 `alarm-cond.prg` 和 `alarm-cond2.prg` 则在两种 CIA 模型、两种入口
上分别逐字段把 TOD 时间写成当前 alarm、把 alarm 写成当前 TOD：小时、分钟和秒写入后不得
提前设置 ICR alarm 源，最后写入十分之一秒完成相等状态时必须立即设置。两个程序每轮都会先
写一次阶段性 `$D7FF=$00`，所以门禁必须收到连续两次 `$00` 并保持绿色边框，不能把首次写入
误判为成功。`verify:cia:tod-alarm` 可单独运行两个程序的八组矩阵；完整 `verify:cia:tod` 已
包含它们，因此 `verify:reference` 也会持续覆盖。

`verify:vic` 会验证 PAL 光栅 IRQ，并把光笔同步边框色、动态坏线、hires/multicolor
精灵优先级以及 `$D017` 在第 54、57 周期切换时的五个完整画面分别与 VICE revision 46176 参考 PNG
比较。每张画面必须有 104,448 个色板索引像素完全一致，不使用 RGB 容差掩盖时序偏移。

`verify:vic:sprites` 会从干净 BASIC 启动 revision 46176 的两项 VICE 精灵碰撞程序，
分别验证 6 个精灵—精灵碰撞周期位置和 39 个精灵—前景碰撞周期位置。参考程序通过
`$D7FF` 与边框颜色同时报告结果；两个 PRG 都固定 SHA-256，缓存损坏时直接失败。

`verify:prg-autostart` 会在项目自己的 KERNAL/BASIC、6510 和整机调度路径中启动 VICE
revision 46176 的 `basictest.prg`。测试程序会检查 `$2D`、`$2F`、`$31` 与 `$AE` 四组
BASIC 结束指针，并通过 `$D7FF` 明确报告成功或失败；参考程序和本地缓存都必须通过固定
SHA-256 校验，不会把“PC 已进入 RAM”误当成程序已经正确运行。

`verify:programs` 会逐个校验六个内置 PRG 的 SHA-256，从干净复位进入 BASIC 后使用同一
`RUN` 路径启动，并让每个程序持续执行 180 个 PAL 帧。门禁要求 CPU 未进入 JAM、程序
执行过足够多的 RAM 地址与不同 PC、实际写入屏幕和 I/O，并让 Canvas 像素明显偏离
BASIC READY 画面。`verify:browser` 会在真实 Chromium 中再次比较载入前后的 Canvas
像素，同时检查桌面交互、移动端横向溢出以及控制台错误。

## 模拟精度

项目追求的是可验证的兼容性，不是无边界地复制每一种物理误差。CPU 总线周期、VIC-II
DMA、CIA 引脚、键盘矩阵、控制端口选择、光笔边沿和媒体位流会被程序观察，因此需要按
目标芯片和制式精确建模。电阻公差、随机噪声、马达惯性和显像管余辉等细节，只有在能
说明具体软件或输出影响，并存在独立参考时才进入默认硬件模型。

当前阶段以 PAL C64、PRG 正常运行、常见磁带/磁盘/卡带链路以及固定外部参考门禁作为
验收范围。通过这些门禁表示所列行为已经被独立程序覆盖，不等同于宣称所有芯片批次、
所有扩展硬件或 VICE 的全部测试库均已完成；未支持的媒体硬件会明确报错，不会静默切换
到猜测性兼容路径。

宿主输入、页面布局、显示缩放、音频缓冲和通用数据结构采用现代浏览器方法。它们通过
明确适配器连接硬件核心，不改变寄存器值、周期顺序和总线状态，也不在失败时切换到
隐式兼容分支。PRG 快捷载入在每个完整 PAL 帧后归还浏览器事件循环，但 VIC 仍决定帧
边界，CPU、CIA、SID 与可选 1541 的周期不会被跳过；1×/2× 显示也严格对应 403×284
输出的整数像素倍数。

## 目录

```text
src/
  app/        React 应用、组件与状态适配器（.tsx/.ts 分离）
  core/       CPU、内存总线及公共协议
  devices/    VIC-II、MOS 6526、SID 与键盘矩阵
  media/      PRG、CRT、D64、G64 与 TAP 媒体格式
  peripherals/控制端口、User Port、IEC、Datasette 与独立 1541 驱动器
  platform/   浏览器资源、键盘与虚拟摇杆适配器
  video/      Canvas 光栅渲染器
  shared/     无平台依赖的公共工具
public/
  firmware/   BASIC、KERNAL、字符 ROM
  programs/   示例 PRG
tests/        单元与集成测试
```

## 公共 API

```ts
import { C64Emulator } from './src/core/C64Emulator';

const emulator = await C64Emulator.create({ canvasHost: element });
await emulator.loadProgram('/programs/galaga.prg');
emulator.start();
```

CRT 工厂显式支持 Generic（type 0）、Ocean（type 5）、Magic Desk（type 19）和
EasyFlash（type 32）。EasyFlash 包含 64 个 8 KiB bank、两颗独立 AM29F040B、IO1
bank/mode 寄存器、256 字节 IO2 RAM、Jumper 模式以及可观察的编程、擦除、状态位和
忙周期；软复位保留 Flash 与卡上 RAM。其它 CRT hardware type 会被明确拒绝。

TAP 播放使用 `mountTap`、`playTape`、`stopTape` 和 `rewindTape`。需要让 C64 程序真实
执行磁带 SAVE 时，可先创建并挂载空白可写介质；录音只采集马达开启期间 6510 WRITE
线的物理磁通边沿，停止后可导出标准 TAP v1：

```ts
const tape = emulator.mountBlankTap();
emulator.recordTape();
// 在 C64 内执行 SAVE"PROGRAM",1；KERNAL 自行控制 MOTOR 与 WRITE。
emulator.stopTape();
const tapBytes = tape.toBytes();
```

可写介质允许按脉冲边界定位并从当前位置覆盖；真正启动马达前不会擦除后续内容。

配置合法的 16 KiB 1541 ROM 后，可以通过同一驱动器硬件路径挂载扇区型 D64 或原始
半轨型 G64；G64 会保留逐字节速度区，适用于自定义 GCR 和复制保护磁道。媒体位流、
物理旋转相位和 GCR 读写电路是三个独立边界，因此空半轨不会被伪装成稳定 `$55` 数据，
速度区元数据也不会改变主轴 RPM。

SID 音频路径在芯片周期域推进。MOS 6581 使用独立的非线性 NMOS 运放、VCR、非理想
截止 DAC、共振与混音增益表；MOS 8580 使用其线性二积分环参数。两个型号的滤波输出均
由固定版本的独立 C++ 参考进程执行逐样本零容差回归，随后再经过 C64 主板输出滤波和
周期域重采样。

## 来源与许可

本项目采用 MIT License。完整许可文本见 [LICENSE](LICENSE)。
