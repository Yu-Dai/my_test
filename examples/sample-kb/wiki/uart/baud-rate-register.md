---
title: 鮑率暫存器 BRR
type: entity
summary: UART0 的 BRR 暫存器（偏移 0x04）：低 16 位元是除數，只能在 CR.EN 為 0 時修改
keywords: [BRR, 鮑率暫存器, 除數, divisor, baud rate register]
aliases: [UART_BRR, 波特率暫存器]
sources:
  - raw/uart-spec.md#3.2
updated: 2026-11-22
---

## 內容

BRR 位於 [[uart/controller|UART0]] 偏移 `0x04`，可讀寫。

- 低 16 位元是除數，其餘位元保留。
- 鮑率 = PCLK / (16 × BRR)，計算方式與常用值見 [[uart/baud-rate]]。
- BRR 為 0 時 UART0 停止運作。
- 修改 BRR 之前必須先清除 CR.EN。

## 相關頁面

- [[uart/baud-rate]]：鮑率的計算與誤差
- [[uart/controller]]：CR.EN 的說明

## 來源

- raw/uart-spec.md#3.2
