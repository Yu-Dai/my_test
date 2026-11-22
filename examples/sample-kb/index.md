# DB1 UART 範例知識庫 目錄

> 此檔由 `kb rebuild` 產生，請勿手動修改。

## gpio

- [[gpio/pin-mux]] 腳位多工（PINMUX） — DB1 的腳位功能選擇：UART0 使用 PA9、PA10 的功能 1，以及與除錯 trace 共用腳位的限制

## guide

- [[guide/debug-no-output]] UART 沒有輸出或收到亂碼的除錯步驟 — 依錯誤碼與症狀排查 UART0 問題：沒有輸出、收不到資料、亂碼、資料遺失的常見原因與檢查順序
- [[guide/init-uart]] 初始化 UART0 — 初始化 UART0 的六個步驟與對應的 uart_init 呼叫方式，包含腳位多工、鮑率、中斷設定的順序
- [[guide/polling-vs-interrupt]] 輪詢接收與中斷接收的比較 — 比較 uart_read_polling 與 uart_read_irq 兩種接收方式的行為、錯誤處理、資料遺失風險與適用情境

## uart

- [[uart/baud-rate]] 鮑率計算 — UART0 鮑率的計算式、驅動程式的四捨五入做法、115200 對應的除數與誤差容許範圍
- [[uart/baud-rate-register]] 鮑率暫存器 BRR — UART0 的 BRR 暫存器（偏移 0x04）：低 16 位元是除數，只能在 CR.EN 為 0 時修改
- [[uart/controller]] UART0 控制器 — DB1 上的 UART0 控制器：位址、時脈、四個暫存器，以及資料暫存器 DR 與控制暫存器 CR 的位元
- [[uart/driver-source]] UART0 驅動程式原始碼摘要 — uart_drv.c 與 uart_drv.h 的結構：公開函式、設定結構、錯誤碼、接收用的環狀緩衝區
- [[uart/fifo-and-interrupt]] FIFO 與中斷 — UART0 的 16 層 FIFO、接收門檻 8 層、接收逾時中斷，以及中斷服務程式必須把 FIFO 讀空的原因
- [[uart/frame-format]] UART 訊框格式 — UART0 一個訊框的組成：起始位元、8 個資料位元（LSB 先送）、可選同位元、1 或 2 個停止位元
- [[uart/spec-summary]] DB1 UART 控制器規格摘要 — DB1 UART0 規格書的重點整理：基本能力、暫存器配置、FIFO、中斷與初始化順序
- [[uart/status-register]] 狀態暫存器 SR — UART0 的 SR 暫存器（偏移 0x08）：TXE、RXNE 與三個錯誤旗標 OVR、FE、PE 的意義與清除方式
