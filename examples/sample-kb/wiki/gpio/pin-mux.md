---
title: 腳位多工（PINMUX）
type: entity
summary: DB1 的腳位功能選擇：UART0 使用 PA9、PA10 的功能 1，以及與除錯 trace 共用腳位的限制
keywords: [腳位多工, PINMUX, pinmux, PA9, PA10, GPIO, 腳位, pin, TX, RX, 上拉電阻]
aliases: [pin mux, 腳位功能選擇, pinmux_set]
sources:
  - raw/gpio-notes.txt:L3-L8
  - raw/gpio-notes.txt:L10-L13
updated: 2026-11-22
---

## 內容

每支腳位有一個 4 位元的功能選擇欄位，位於 PINMUX 暫存器（`0x4000_0100` 起）。功能 0 是 GPIO，上電後所有腳位都是功能 0。

### UART0 的腳位

| 腳位 | 功能編號 | 訊號 |
| --- | --- | --- |
| PA9 | 1 | UART0_TX |
| PA10 | 1 | UART0_RX |

### 注意事項

- PA9、PA10 同時是除錯器的 SWO 與 TRACE 腳位（功能 3）。開啟 trace 時 UART0 無法使用。
- 腳位切到 UART0 之前 TX 線是浮接的，對方可能收到一個雜訊位元組。
- RX 腳位沒有內建上拉電阻。線沒接時會持續收到訊框錯誤，要在板子上加 10k 上拉。

## 相關頁面

- [[guide/init-uart]]：初始化時設定腳位的步驟
- [[guide/debug-no-output]]：腳位沒切造成的症狀

## 來源

- raw/gpio-notes.txt:L3-L8
- raw/gpio-notes.txt:L10-L13
