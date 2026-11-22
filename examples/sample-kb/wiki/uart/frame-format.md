---
title: UART 訊框格式
type: concept
summary: UART0 一個訊框的組成：起始位元、8 個資料位元（LSB 先送）、可選同位元、1 或 2 個停止位元
keywords: [訊框, frame, 起始位元, 停止位元, 同位元, start bit, stop bit, parity, LSB, 時序]
aliases: [frame format, 資料格式, 8N1]
sources:
  - raw/uart-spec.md#訊框格式
updated: 2026-11-22
---

## 內容

閒置時 TX 線為高電位。每個訊框依序是：

1. 1 個起始位元（低電位）
2. 8 個資料位元，LSB 先送
3. 可選的同位元（CR.PEN）
4. 1 或 2 個停止位元（高電位，CR.STP2）

![UART 訊框時序圖：閒置為高電位，接著是低電位的起始位元、八個高低交替的資料位元（0x55），最後回到高電位的停止位元](assets/uart-spec-001.png)

接收端在每個位元的中間點取樣。停止位元取樣到低電位就是訊框錯誤，見 [[uart/status-register]]。

## 相關頁面

- [[uart/baud-rate]]：鮑率誤差對取樣的影響
- [[uart/controller]]：CR 的 PEN 與 STP2 位元

## 來源

- raw/uart-spec.md#訊框格式
