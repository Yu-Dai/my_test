---
title: DB1 UART 控制器規格摘要
type: summary
summary: DB1 UART0 規格書的重點整理：基本能力、暫存器配置、FIFO、中斷與初始化順序
keywords: [UART, UART0, 規格, 規格書, spec, 串列埠, serial, DB1]
aliases: [UART 規格書, uart-spec]
sources:
  - raw/uart-spec.md#1
  - raw/uart-spec.md#3
  - raw/uart-spec.md#5
updated: 2026-11-22
---

## 內容

規格書版本 1.2，描述示範板 DB1 上的 [[uart/controller|UART0 控制器]]。

### 基本能力

- 位址 `0x4000_1000`，輸入時脈 PCLK 為 48 MHz。
- 鮑率 1200 到 921600，見 [[uart/baud-rate]]。
- 資料位元固定 8 位元，可選同位元，停止位元 1 或 2，見 [[uart/frame-format]]。
- 傳送與接收各 16 層 FIFO，中斷編號 IRQ 5，見 [[uart/fifo-and-interrupt]]。

### 暫存器

| 偏移 | 名稱 | 說明 | 頁面 |
| --- | --- | --- | --- |
| 0x00 | DR | 資料暫存器 | [[uart/controller]] |
| 0x04 | BRR | 鮑率暫存器 | [[uart/baud-rate-register]] |
| 0x08 | SR | 狀態暫存器 | [[uart/status-register]] |
| 0x0C | CR | 控制暫存器 | [[uart/controller]] |

### 初始化

規格書第 5 節列出六個步驟，整理在 [[guide/init-uart]]。

## 相關頁面

- [[uart/driver-source]]：對應的驅動程式
- [[guide/debug-no-output]]：沒有輸出時的檢查方法

## 來源

- raw/uart-spec.md#1
- raw/uart-spec.md#3
- raw/uart-spec.md#5
