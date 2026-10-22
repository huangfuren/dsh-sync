// lib/lan/constants.js — 局域网直传的常量。
//
// 端口选择的原则：**固定、好记、好放行**。局域网直传最常见的失败不是协议问题，而是
// Windows 防火墙拦了入站。固定端口意味着用户只需要放行一次，而不是每次都查「这次用了哪个端口」。

/** 发送端服务端口（配对 + 传输 + 进度页共用）。被占用时按 LAN_PORT_SPAN 顺延。 */
export const LAN_DEFAULT_PORT = 38473
export const LAN_PORT_SPAN = 10

/** 接收端进度页端口。只监听 127.0.0.1，不对外暴露。 */
export const LAN_PROGRESS_PORT = 38474
export const LAN_PROGRESS_PORT_SPAN = 10

/** UDP 广播发现端口。 */
export const DISCOVERY_PORT = 38472
/** 发现请求的载荷。带版本号，方便以后换协议时老客户端直接被忽略而不是误解。 */
export const DISCOVERY_REQUEST = 'DSHSYNC?1'

/** 本协议版本。与 bundle 的 FORMAT_VERSION 无关：bundle 能读但协议不兼容时也要明确拒绝。 */
export const LAN_PROTOCOL_VERSION = 1

/** 服务端标识头，出现在 /info 与每个响应里，便于一眼看出对面是不是 dsh-sync。 */
export const LAN_SERVICE_ID = 'dsh-sync-lan'

/**
 * 帧格式：MAGIC(4) + TYPE(1) + LEN(4, BE) + PAYLOAD。
 *
 * 为什么不用「每文件一个 HTTP 请求」：一个 bundle 实测 2305 个文件，逐文件请求意味着
 * 2305 次往返；局域网 RTT 按 0.3ms 算也有 0.7 秒纯等待，而更大的问题是进度粒度只能到
 * 文件级，小文件多的时候进度条会跳。一条连接连续推帧，进度可以按字节平滑推进。
 *
 * 为什么不用 tar/zip 打包：打包要多一次全量读 + 压缩 CPU，解包要多一次全量写，
 * 而 bundle 里已经是压缩过的会话文件（zstd）与 `.git` 对象（zlib），再压几乎没有收益。
 * 直接传文件内容，省掉两端各一遍，也让「边收边校验 sha256」成为可能。
 */
export const FRAME_MAGIC = 'DSHX'
export const FRAME_HEADER_BYTES = 9

/** 帧类型。DATA 是裸字节，其余都是 UTF-8 JSON。 */
export const FRAME = Object.freeze({
  /** 一个文件开始：{path, size, sha256} */
  FILE: 1,
  /** 文件内容块：裸字节 */
  DATA: 2,
  /** 一个文件结束：{path}（哈希已在 FILE 头里给过，接收端边收边算） */
  FEND: 3,
  /** 全部结束：{files, bytes, durationMs} */
  DONE: 4,
  /** 服务端出错：{message} */
  ERR: 5,
})

/**
 * 单帧载荷上限。DATA 帧按 CHUNK_SIZE 切，JSON 帧远小于此。
 * 设上限是为了让「对面不是 dsh-sync 却连上来」或「流被中间设备改写」这两种情况
 * 立刻以明确错误中止，而不是先分配 4GB 内存再崩在别处。
 */
export const MAX_FRAME_PAYLOAD = 8 * 1024 * 1024

/** DATA 帧的块大小。256 KB 在吞吐与进度平滑度之间比较平衡。 */
export const CHUNK_SIZE = 256 * 1024

/** 配对码有效期。够输完，又不至于让一个泄漏的码长期可用。 */
export const PAIR_CODE_TTL_MS = 5 * 60_000
/** 配对码最多试错次数。6 位数字共 100 万种，5 次即穷举概率 5e-6。 */
export const PAIR_MAX_ATTEMPTS = 5
/** 配对成功后等对方点「接受」的最长时间。 */
export const PAIR_WAIT_MS = 5 * 60_000
/** 等对方点「接受」时，长轮询单次挂起的时长。 */
export const PAIR_LONGPOLL_MS = 25_000

/** 接收端先写这个后缀的临时文件，校验通过后才改名成正式文件名。 */
export const PART_SUFFIX = '.dshsync-part'

/** 传输过程中空闲多久算断线（防止半开连接永远挂着）。 */
export const TRANSFER_IDLE_TIMEOUT_MS = 60_000
