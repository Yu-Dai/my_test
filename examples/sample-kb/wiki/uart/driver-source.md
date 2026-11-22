---
title: UART0 驅動程式原始碼摘要
type: summary
summary: uart_drv.c 與 uart_drv.h 的結構：公開函式、設定結構、錯誤碼、接收用的環狀緩衝區
keywords: [驅動程式, driver, uart_drv, uart_init, uart_write, uart_read_polling, uart_read_irq, 原始碼]
aliases: [uart_drv.c, uart_drv.h, UART driver]
sources:
  - raw/uart_drv.h:L11-L30
  - raw/uart_drv.c:L20-L29
  - raw/uart_drv.c:L79-L90
updated: 2026-11-22
---

## 內容

驅動程式由 `uart_drv.h`（介面）與 `uart_drv.c`（實作）組成，只支援 [[uart/controller|UART0]] 一個裝置。

### 公開函式

| 函式 | 用途 | 說明頁面 |
| --- | --- | --- |
| `uart_init` | 依設定結構初始化 | [[guide/init-uart]] |
| `uart_set_baud` | 計算並寫入除數 | [[uart/baud-rate]] |
| `uart_write` | 阻塞式傳送，等 SR.TXE 再寫 DR | 本頁 |
| `uart_read_polling` | 輪詢接收，帶逾時 | [[guide/polling-vs-interrupt]] |
| `uart_read_irq` | 從環狀緩衝區取資料 | [[guide/polling-vs-interrupt]] |
| `uart0_irq_handler` | 中斷服務程式 | [[uart/fifo-and-interrupt]] |

### 設定結構 uart_config_t

- `baud`：1200 到 921600。
- `parity`：0 關閉，1 啟用。
- `stop_bits`：1 或 2。
- `use_irq`：0 用輪詢接收，1 用中斷接收。

### 錯誤碼

`UART_OK`（0）、`UART_E_PARAM`（-1）、`UART_E_TIMEOUT`（-2）、`UART_E_OVERRUN`（-3）、`UART_E_FRAME`（-4）。各錯誤碼的常見原因見 [[guide/debug-no-output]]。

### 接收緩衝區

中斷模式使用 256 位元組的環狀緩衝區 `rx_ring`。緩衝區滿時新資料被丟棄，並累加 `rx_dropped`。

## 相關頁面

- [[uart/spec-summary]]：硬體規格
- [[uart/status-register]]：驅動程式檢查的狀態位元

## 來源

- raw/uart_drv.h:L11-L30
- raw/uart_drv.c:L20-L29
- raw/uart_drv.c:L79-L90
