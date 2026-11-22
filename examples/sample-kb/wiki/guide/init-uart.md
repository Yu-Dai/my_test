---
title: 初始化 UART0
type: howto
summary: 初始化 UART0 的六個步驟與對應的 uart_init 呼叫方式，包含腳位多工、鮑率、中斷設定的順序
keywords: [初始化, init, uart_init, 設定, 啟用, uart_config_t, 初始化順序]
aliases: [UART 初始化, initialize UART, 開啟串列埠]
sources:
  - raw/uart-spec.md#5
  - raw/uart_drv.c:L48-L77
  - raw/uart_drv.h:L18-L23
updated: 2026-11-22
---

## 內容

### 步驟

1. 設定腳位多工，把 PA9、PA10 切到 UART0 功能，見 [[gpio/pin-mux]]。
2. 清除 CR.EN。
3. 寫入 BRR，見 [[uart/baud-rate]]。
4. 設定 CR 的 PEN、STP2。
5. 需要中斷時設定 CR.RXIE，並在中斷控制器啟用 IRQ 5。
6. 設定 CR.EN。

順序的重點：BRR 只能在停用時修改，EN 一定最後設定。

### 用驅動程式

`uart_init` 已經照上述順序實作，呼叫一次即可：

```c
uart_config_t cfg = { .baud = 115200, .parity = 0, .stop_bits = 1, .use_irq = 1 };
int rc = uart_init(&cfg);
```

- 回傳 `UART_OK`（0）代表成功。
- `stop_bits` 不是 1 或 2、鮑率超出範圍時回傳 `UART_E_PARAM`。
- `use_irq` 為 1 時會清空接收緩衝區並啟用 IRQ 5，之後用 `uart_read_irq` 取資料。

## 相關頁面

- [[uart/controller]]：CR 各位元的意義
- [[guide/polling-vs-interrupt]]：決定 use_irq 要設 0 還是 1
- [[guide/debug-no-output]]：初始化後沒有輸出時怎麼查

## 來源

- raw/uart-spec.md#5
- raw/uart_drv.c:L48-L77
- raw/uart_drv.h:L18-L23
