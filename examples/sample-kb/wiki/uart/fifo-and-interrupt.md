---
title: FIFO 與中斷
type: concept
summary: UART0 的 16 層 FIFO、接收門檻 8 層、接收逾時中斷，以及中斷服務程式必須把 FIFO 讀空的原因
keywords: [FIFO, 中斷, interrupt, IRQ, IRQ 5, 接收門檻, 逾時, RXIE, 中斷服務程式, ISR, uart0_irq_handler]
aliases: [接收中斷, RX interrupt, 緩衝區]
sources:
  - raw/uart-spec.md#4
  - raw/uart_drv.c:L119-L133
updated: 2026-11-22
---

## 內容

### FIFO

傳送與接收 FIFO 各 16 層。接收 FIFO 已滿時又收到資料，新資料會被丟棄並設定 [[uart/status-register|SR.OVR]]。

### 中斷觸發條件

CR.RXIE 為 1 時，以下任一情況觸發 IRQ 5：

- 接收 FIFO 內達到 8 個位元組（門檻固定）。
- 接收逾時：FIFO 內有資料，但連續 4 個字元時間沒有新資料。

逾時中斷的用途是避免不足 8 個位元組的資料卡在 FIFO。

### 中斷服務程式的要求

必須把接收 FIFO 讀到 SR.RXNE 為 0，否則中斷會立刻再次觸發。驅動程式的 `uart0_irq_handler` 用 while 迴圈讀到空為止，把資料放進 256 位元組的環狀緩衝區；緩衝區滿時丟棄該位元組並累加 `rx_dropped`。

## 相關頁面

- [[guide/polling-vs-interrupt]]：輪詢與中斷兩種接收方式的比較
- [[uart/driver-source]]：驅動程式整體結構

## 來源

- raw/uart-spec.md#4
- raw/uart_drv.c:L119-L133
