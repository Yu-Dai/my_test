---
title: UART 沒有輸出或收到亂碼的除錯步驟
type: howto
summary: 依錯誤碼與症狀排查 UART0 問題：沒有輸出、收不到資料、亂碼、資料遺失的常見原因與檢查順序
keywords: [除錯, debug, 沒有輸出, 亂碼, 收不到, 資料遺失, 錯誤碼, error code, UART_E_TIMEOUT, UART_E_FRAME, UART_E_OVERRUN, troubleshooting]
aliases: [UART 除錯, UART 不通, no output, garbage characters]
sources:
  - raw/error-codes.csv:L2-L6
  - raw/gpio-notes.txt:L10-L13
  - raw/uart-spec.md#3.3
updated: 2026-11-22
---

## 內容

### 依症狀檢查

| 症狀 | 錯誤碼 | 先檢查 |
| --- | --- | --- |
| 完全沒有輸出 | 無 | 腳位多工是否切到功能 1；除錯器 trace 是否佔用 PA9、PA10 |
| 收不到任何資料 | `UART_E_TIMEOUT`（-2） | 線是否接好、對方是否有送、腳位多工 |
| 亂碼或訊框錯誤 | `UART_E_FRAME`（-4） | 兩端鮑率是否一致；RX 線是否浮接 |
| 資料遺失 | `UART_E_OVERRUN`（-3） | 輪詢是否太慢；中斷是否被關閉太久 |
| 初始化失敗 | `UART_E_PARAM`（-1） | 鮑率是否在 1200 到 921600；停止位元是否為 1 或 2 |

### 檢查順序

1. 確認腳位。PA9、PA10 必須是功能 1，見 [[gpio/pin-mux]]。開啟 trace 時 UART0 無法使用。
2. 確認鮑率。誤差要小於 2%，見 [[uart/baud-rate]]。
3. 讀 [[uart/status-register|SR]]。FE 代表鮑率不符或 RX 浮接，OVR 代表讀取太慢。
4. RX 線沒接時會持續出現訊框錯誤。板子上要有 10k 上拉電阻。
5. 資料遺失時改用中斷接收，見 [[guide/polling-vs-interrupt]]。

## 相關頁面

- [[guide/init-uart]]：確認初始化順序正確
- [[uart/driver-source]]：錯誤碼的定義位置

## 來源

- raw/error-codes.csv:L2-L6
- raw/gpio-notes.txt:L10-L13
- raw/uart-spec.md#3.3
