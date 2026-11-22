---
title: 輪詢接收與中斷接收的比較
type: comparison
summary: 比較 uart_read_polling 與 uart_read_irq 兩種接收方式的行為、錯誤處理、資料遺失風險與適用情境
keywords: [輪詢, 中斷, polling, interrupt, uart_read_polling, uart_read_irq, 接收, 比較, use_irq]
aliases: [polling vs interrupt, 接收方式, 阻塞, 非阻塞]
sources:
  - raw/uart_drv.c:L92-L117
  - raw/uart_drv.c:L119-L144
  - raw/uart-spec.md#4
updated: 2026-11-22
---

## 內容

| 項目 | 輪詢（`uart_read_polling`） | 中斷（`uart_read_irq`） |
| --- | --- | --- |
| 設定 | `use_irq = 0` | `use_irq = 1` |
| 呼叫行為 | 阻塞，直到收滿或逾時 | 不阻塞，回傳緩衝區內現有的資料 |
| 緩衝空間 | 只有硬體 FIFO 的 16 層 | 硬體 FIFO 加 256 位元組環狀緩衝區 |
| 錯誤回報 | 回傳 `UART_E_FRAME`、`UART_E_OVERRUN`、`UART_E_TIMEOUT` | 不回報錯誤，緩衝區滿時只累加 `rx_dropped` |
| 資料遺失風險 | 高：兩次呼叫之間超過 16 個位元組就溢位 | 低：除非主程式長時間不取資料 |

### 怎麼選

- 開機訊息、簡單的命令列：用輪詢，程式簡單，錯誤看得到。
- 高鮑率或連續資料流：用中斷。115200 鮑率下 16 層 FIFO 約 1.4 毫秒就會滿。
- 需要知道訊框錯誤：用輪詢。中斷模式目前不檢查 FE 與 OVR。

## 相關頁面

- [[uart/fifo-and-interrupt]]：中斷觸發條件
- [[guide/init-uart]]：設定 use_irq 的位置

## 來源

- raw/uart_drv.c:L92-L117
- raw/uart_drv.c:L119-L144
- raw/uart-spec.md#4
