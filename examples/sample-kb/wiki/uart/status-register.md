---
title: 狀態暫存器 SR
type: entity
summary: UART0 的 SR 暫存器（偏移 0x08）：TXE、RXNE 與三個錯誤旗標 OVR、FE、PE 的意義與清除方式
keywords: [SR, 狀態暫存器, status register, TXE, RXNE, OVR, FE, PE, 溢位, 訊框錯誤, 同位元錯誤]
aliases: [UART_SR, overrun, framing error, parity error]
sources:
  - raw/uart-spec.md#3.3
  - raw/uart_drv.c:L92-L117
updated: 2026-11-22
---

## 內容

SR 位於 [[uart/controller|UART0]] 偏移 `0x08`，唯讀。

| 位元 | 名稱 | 說明 |
| --- | --- | --- |
| 0 | TXE | 傳送 FIFO 有空位 |
| 1 | RXNE | 接收 FIFO 有資料 |
| 2 | OVR | 接收溢位：FIFO 已滿時又收到資料，新資料被丟棄 |
| 3 | FE | 訊框錯誤：停止位元取樣到低電位，通常代表鮑率不符 |
| 4 | PE | 同位元錯誤 |

### 清除錯誤旗標

OVR、FE、PE 的清除方式是：先讀 SR，再讀 DR。驅動程式的 `uart_read_polling` 在發現 FE 或 OVR 時會讀一次 DR 來清除，然後回傳對應的錯誤碼。

## 相關頁面

- [[guide/debug-no-output]]：依錯誤旗標判斷問題
- [[uart/fifo-and-interrupt]]：OVR 與 FIFO 的關係

## 來源

- raw/uart-spec.md#3.3
- raw/uart_drv.c:L92-L117
