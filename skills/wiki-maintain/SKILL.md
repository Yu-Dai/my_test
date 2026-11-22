---
name: wiki-maintain
description: 建立與維護 LLM Wiki 知識庫。使用者要求建立知識庫、把文件或程式碼整理進知識庫（ingest）、檢查知識庫時使用。
---

# 維護 wiki 知識庫

所有步驟都靠 `kb` 指令。`kb` 的輸出會告訴你下一步做什麼，**照輸出的「下一步」做**。

## 規則

- 你只能新增或修改 `wiki/` 裡的頁面檔。
- 不要修改 `index.md`、`log.md`、`.kb/`、`raw/`。這些由 `kb` 指令處理。
- 不要自己執行 `git` 指令。
- 不知道的欄位去問使用者，不要自己編。
- 只寫來源裡有的內容。

## 建立新的知識庫

1. 向使用者問這六項：代號（name）、名稱（title）、一句話描述（description）、擁有者（owner）、分類（category）、機密等級（confidentiality）。
2. 執行：

   ```
   kb init <資料夾> --name <代號> --title "<名稱>" --description "<描述>" --owner <擁有者> --category <分類> --confidentiality <機密等級>
   ```

3. 照輸出的「下一步」做。

## 把來源整理進知識庫（ingest）

一次處理一份來源。在知識庫資料夾內執行。

1. 執行 `kb ingest start`，看有哪些來源待處理。
2. 執行 `kb ingest start <來源檔>`，例如 `kb ingest start raw/spec.md`。
   輸出包含：要做的事、相關的既有頁面、頁面範本、來源內容。
3. 輸出說來源有很多段時，用 `kb ingest part 2`、`kb ingest part 3` … 讀完全部。
4. 在 `wiki/<分類>/<名稱>.md` 新增或修改頁面，照範本寫。
5. 執行 `kb ingest commit`。
   - 出現 `[錯誤]`：照每一項的「正確寫法」修改檔案，再執行 `kb ingest commit`。重複到通過。
   - 出現「ingest 完成」：這份來源處理完了。輸出會列出下一份待處理的來源。
6. 還有待處理的來源就回到步驟 2。

來源檔是 PDF、Word、Excel、PowerPoint 時不能直接處理，`kb ingest start` 會擋下。請使用者先轉成 markdown。

想放棄目前這一份、把頁面還原：`kb ingest abort`。
忘記做到哪裡：`kb ingest status`。

## 修改既有頁面（與新來源無關）

修錯字、補關鍵字、修檢查找到的問題時使用。

1. 直接修改 `wiki/` 裡的頁面。
2. 執行 `kb commit "一句話說明改了什麼"`。有 `[錯誤]` 就照訊息修正再執行一次。

## 檢查知識庫（lint）

1. 執行 `kb lint`。
2. `[錯誤]` 一定要處理，`[警告]` 逐項判斷。每一項都有「正確寫法」與「下一步」，照著做。
3. 修改了頁面就執行 `kb commit "修正 lint 問題"`。
4. 再執行一次 `kb lint` 確認。

### 內容檢查（使用者要求時才做）

`kb lint` 檢查不了內容對不對。使用者要求檢查內容時：

1. 讀 `index.md`，一次挑一個分類。
2. 讀該分類的每一頁，找這兩種問題：
   - 兩頁對同一件事的說法互相矛盾。
   - 頁面內容與它 `sources` 指到的來源原文不一致。
3. 把找到的問題列給使用者看，說明是哪兩頁、哪一句。**先不要改**，等使用者決定。
4. 使用者同意後修改頁面，執行 `kb commit "說明"`。

## 檢索測試

檢索測試確認「用某些關鍵字搜尋時，某一頁排在前幾名」。每次 commit 前會自動執行。

- `kb test`：執行全部測試。
- `kb test add --terms "鮑率,baud rate" --expect uart/baud-rate --rank 3`：新增一題。為重要的頁面各加一題，關鍵字用使用者實際會問的詞。
- `kb test remove <題號>`：頁面被刪除或改名、題目不再適用時移除。

測試沒過時，在預期頁面的 `keywords` 或 `aliases` 補上關鍵字。不要為了通過而移除還適用的題目。

## 撤銷

- `kb undo`：撤銷最近一次 ingest 或 commit。來源檔會留在 `raw/`，可以重新處理。
- 只在使用者要求時執行。

## 其他指令

- `kb check`：只檢查格式，比 `kb lint` 快。
- `kb validate wiki/<分類>/<名稱>.md`：只檢查一頁。
- `kb search <關鍵字>`：確認頁面搜尋得到。
- `kb rebuild`：重新產生 `index.md` 與搜尋索引。`kb check` 說索引過期時使用。
