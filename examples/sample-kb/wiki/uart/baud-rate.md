---
title: 鮑率計算
type: concept
summary: UART0 鮑率的計算式、驅動程式的四捨五入做法、115200 對應的除數與誤差容許範圍
keywords: [鮑率, baud rate, baud, 115200, 除數, 誤差, PCLK, uart_set_baud]
aliases: [波特率, baudrate, 傳輸速率]
sources:
  - raw/uart-spec.md#3.2
  - raw/uart-spec.md#2
  - raw/uart_drv.c:L31-L46
updated: 2026-11-22
---

## 內容

### 計算式

```
baud = PCLK / (16 × BRR)
```

PCLK 為 48 MHz。除數寫入 [[uart/baud-rate-register|BRR]]。

### 常用值

| 目標鮑率 | BRR | 實際鮑率 | 誤差 |
| --- | --- | --- | --- |
| 115200 | 26 | 115384 | 0.16% |

### 誤差容許範圍

接收端在每個位元的中間取樣，兩端鮑率誤差必須小於 2%。誤差過大時會出現訊框錯誤（[[uart/status-register|SR.FE]]）。

### 驅動程式的做法

`uart_set_baud` 用四捨五入計算除數：`div = (PCLK + 8 × baud) / (16 × baud)`。鮑率超出 1200 到 921600，或除數為 0、超過 16 位元時，回傳 `UART_E_PARAM`。寫入 BRR 之前會先清除 CR.EN，所以呼叫後 UART0 是停用狀態，要重新啟用。

## 相關頁面

- [[uart/frame-format]]：位元取樣與訊框
- [[guide/debug-no-output]]：鮑率不符時的症狀

## 來源

- raw/uart-spec.md#3.2
- raw/uart-spec.md#2
- raw/uart_drv.c:L31-L46
