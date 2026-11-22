---
title: UART0 控制器
type: entity
summary: DB1 上的 UART0 控制器：位址、時脈、四個暫存器，以及資料暫存器 DR 與控制暫存器 CR 的位元
keywords: [UART0, 控制器, controller, DR, CR, 資料暫存器, 控制暫存器, EN, RXIE, TXIE, PEN, STP2]
aliases: [UART 控制器, 串列埠控制器, data register, control register]
sources:
  - raw/uart-spec.md#1
  - raw/uart-spec.md#3.1
  - raw/uart-spec.md#3.4
updated: 2026-11-22
---

## 內容

UART0 是 DB1 上唯一的非同步串列收發器。

- 基底位址：`0x4000_1000`
- 輸入時脈：PCLK，48 MHz
- 中斷：IRQ 5
- 腳位：PA9（TX）、PA10（RX），見 [[gpio/pin-mux]]

### 資料暫存器 DR（偏移 0x00）

寫入低 8 位元會把一個位元組放進傳送 FIFO，讀取會從接收 FIFO 取出一個位元組。

### 控制暫存器 CR（偏移 0x0C）

| 位元 | 名稱 | 說明 |
| --- | --- | --- |
| 0 | EN | 啟用 UART0 |
| 1 | TXIE | 傳送 FIFO 低於門檻時產生中斷 |
| 2 | RXIE | 接收 FIFO 達到門檻時產生中斷 |
| 3 | PEN | 啟用同位元 |
| 4 | STP2 | 使用 2 個停止位元 |

修改 [[uart/baud-rate-register|BRR]] 之前必須先清除 EN。

## 相關頁面

- [[uart/baud-rate-register]]：鮑率暫存器 BRR
- [[uart/status-register]]：狀態暫存器 SR
- [[uart/spec-summary]]：規格書摘要

## 來源

- raw/uart-spec.md#1
- raw/uart-spec.md#3.1
- raw/uart-spec.md#3.4
