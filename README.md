# LLM Wiki 知識庫系統

以 Karpathy「LLM Wiki」理念為基礎的知識庫：LLM 把原始來源整理成 markdown wiki，AI agent 透過 MCP 檢索。
不需要 embedding model，檢索靠關鍵字與索引；設計上假設模型能力偏弱。

## 目前進度

| 元件 | 狀態 |
| --- | --- |
| 核心函式庫與 `kb` CLI（驗證、索引、搜尋） | 可用 |
| wiki MCP server（唯讀，五個工具，本機路徑掛載） | 可用 |
| MCP 圖片取用（`FetchImage`） | 可用，已實測 agent 能取得並讀懂圖片 |
| 維護 skill：init、ingest、commit、lint、query test、undo、rebuild | 可用 |
| 維護 skill：update（來源有新版時只處理變動的部分） | 可用 |
| 共享知識庫（bare repo 遠端、本機快取、掛載檢查） | 可用，尚未在網路共享資料夾上實測 |
| toMarkdown（PDF、Office 轉 markdown） | 不在這個專案內，另案開發 |

## 安裝

需要 Node.js 20 以上。

```
npm install
npm test
```

## 設定 wiki MCP

### 1. 加入要使用的知識庫

用指令設定，不需要手動編輯設定檔。`<repo>` 是這個專案的絕對路徑；執行過 `npm link` 的話，`node <repo>/src/cli/kb.js` 可以簡寫成 `kb`。

```
node <repo>/src/cli/kb.js mount add D:/kb/my-notes                          本機的知識庫資料夾
node <repo>/src/cli/kb.js mount add //fileserver/share/kb/uart-driver.git   共享知識庫
node <repo>/src/cli/kb.js mount list                                        確認結果
```

第一次執行時會自動建立設定檔 `~/.llm-wiki/config.json`（Windows 為 `C:\Users\<帳號>\.llm-wiki\config.json`）。
想先試用，可以加入 repo 內附的範例知識庫 `examples/sample-kb`。

```
kb mount list                  列出設定檔裡的知識庫與檢查結果
kb mount add <路徑>            加入知識庫
kb mount remove <代號或路徑>   從設定檔移除，不會刪除知識庫的檔案
kb mount disable <代號或路徑>  暫時不掛載，設定保留
kb mount enable <代號或路徑>   重新啟用
kb config get [項目]           顯示設定
kb config set <項目> <值>      修改設定
kb config unset <項目>         回到預設值
kb config path                 顯示設定檔位置
```

- 本機知識庫是裡面有 `kb.json` 的資料夾，用於個人知識庫。
- 共享知識庫是共享資料夾上的儲存庫（維護者執行 `kb share` 時會顯示要執行的 `kb mount add` 指令）。
  MCP 會把它複製到本機快取再讀取，不直接讀網路資料夾。
- `kb mount add` 會當場檢查：路徑是不是知識庫、`kb.json` 是否合格、代號是否與已加入的重複、機密等級是否允許。沒通過就不加入。
- 設定項目 `max_confidentiality`：可掛載的最高機密等級，`public`、`internal`、`confidential` 由低到高，預設 `internal`。
  知識庫的 `kb.json` 等級比它高就不會掛載。調高時要加 `--yes`，由使用者本人確認這個環境可以使用該等級的資料。
- 設定項目 `cache_dir`：共享知識庫的本機快取位置，預設 `~/.llm-wiki/cache`（也可用環境變數 `LLM_WIKI_CACHE`）。
- **修改設定後要重新啟動 MCP 才生效。**
- 要用另一份設定檔時，加上 `--config <路徑>` 或設定環境變數 `LLM_WIKI_CONFIG`。指定位置的設定檔不會自動建立。
- 設定檔的格式見 [config.example.json](config.example.json)。停用的知識庫存在 `disabled_knowledge_bases`。
- 也可以不用設定檔，註冊 MCP 時直接用 `--kb <路徑>` 指定知識庫，可重複多次。

### 2. 在 AI agent 註冊 MCP server

server 以本機 stdio 模式執行，不開網路 port。把 `<repo>` 換成這個專案的絕對路徑。

Kilo Code（`.kilocode/mcp.json` 或全域 MCP 設定）：

```json
{
  "mcpServers": {
    "wiki": {
      "command": "node",
      "args": ["<repo>/src/mcp/server.js"]
    }
  }
}
```

直接指定知識庫、不使用設定檔的寫法：

```json
{
  "mcpServers": {
    "wiki": {
      "command": "node",
      "args": ["<repo>/src/mcp/server.js", "--kb", "<repo>/examples/sample-kb"]
    }
  }
}
```

Claude Code：

```
claude mcp add wiki -- node <repo>/src/mcp/server.js --kb <repo>/examples/sample-kb
```

### 3. 確認

請 agent 呼叫 `GetWikiInfo`。它應該列出已掛載的知識庫。
設定有問題時 server 仍會啟動，`GetWikiInfo` 的回傳會說明哪個路徑掛載失敗與原因。

## MCP 工具

MCP 只讀不寫。模型只需要給「知識庫代號」與「頁面代號」（`分類/名稱`），實際路徑由系統解析。

| 工具 | 參數 | 用途 |
| --- | --- | --- |
| `GetWikiInfo` | `kb`、`category`、`offset`（皆可省略） | 不帶參數列出所有知識庫；帶 `kb` 列出頁面目錄，頁數多時先回分類大綱 |
| `SearchWiki` | `terms` 或 `pattern`、`kb`、`scope`、`limit`、`offset` | `terms`：關鍵字搜尋，任一命中即算。`pattern`：regex 逐行比對，列出命中的行。`scope` 為 `wiki`（預設）或 `raw` |
| `ReadWiki` | `kb`、`pages` | 讀取頁面全文，附該頁連到的頁面與來源清單 |
| `FetchRaw` | `kb`、`path`、`section`、`start_line`、`end_line` | 讀取原始來源檔的指定章節或行數範圍 |
| `FetchImage` | `kb`、`path` | 讀取頁面裡的一張圖片，以 MCP 的圖片內容回傳 |

典型流程：`GetWikiInfo` → `SearchWiki` 或從目錄挑頁 → `ReadWiki` → 內容不足時 `FetchRaw`，需要看圖時 `FetchImage`。

- `SearchWiki` 兩種搜尋方式擇一：`terms` 適合找主題（依標題、關鍵字、摘要、內文加權排序）；
  `pattern` 適合找有固定格式的東西（函式名、暫存器位址、錯誤碼），不分大小寫、一次比對一行，找程式碼時加 `scope="raw"`。
  樣式寫錯時會當成一般文字比對；比對超過 3 秒會中止並請模型換較簡單的樣式。
- 每個工具都有輸出上限，超過時截斷並說明如何取得後續。
- 查無結果或參數錯誤時，回傳會給下一步建議。
- 知識庫內容變動（`kb rebuild` 之後）會自動重新載入，不需要重啟 server。
- 共享知識庫在 server 啟動時更新快取。更新在背景進行，啟動後馬上可以用既有的快取檢索。
  更新失敗（例如離線）時沿用快取，`GetWikiInfo` 會註明快取日期與失敗原因。
- 掛載時檢查：知識庫代號是否重複、`schema_version` 是否支援、機密等級是否允許。沒通過的知識庫不掛載，原因列在 `GetWikiInfo`。
- 頁面中的圖片路徑會轉成 `kb://知識庫代號/assets/檔名`，`ReadWiki` 會在頁面後面列出「本頁的圖片」，把路徑交給 `FetchImage` 就能讀圖。
  模型能不能真的看到圖，取決於 agent 平台是否把 MCP 回傳的圖片交給模型、以及模型是否支援圖片；看不到時回傳的文字會請模型改依說明文字回答。
  單張上限 1 MB；SVG 以原始碼文字回傳。

## 建立與維護知識庫

維護者用 AI agent（例如 Kilo Code）加上維護 skill 作業。需要 git，並已設定 `user.name` 與 `user.email`。

### 準備

1. 讓 `kb` 指令可用。在這個專案的資料夾執行一次：

   ```
   npm link
   ```

   之後任何位置都能執行 `kb`。不想用 `npm link` 的話，把下文的 `kb` 換成 `node <repo>/src/cli/kb.js`。

2. 把 [skills/wiki-maintain](skills/wiki-maintain) 資料夾複製到 agent 的 skill 目錄。

   使用者也可以先裝 skill、還沒裝這套工具：skill 一開始會檢查 `kb` 指令，不能用時請使用者到指定路徑安裝。
   `SKILL.md` 裡的路徑是範例（`//fileserver/share/tools/llm-wiki`），發佈前換成這個專案實際放置的位置。

### 流程

```
kb init <資料夾> --name <代號> --title "<名稱>" --description "<描述>" --owner <擁有者> --category <分類> --confidentiality <機密等級>
```

建立資料夾結構、`kb.json`、`SCHEMA.md` 與 git repo。接著把來源文字檔放進 `raw/`，然後：

```
kb ingest start                列出待處理的來源
kb ingest start raw/spec.md    開始處理一份來源：輸出步驟、相關頁面、頁面範本、來源內容
kb ingest part 2               來源較長時讀取下一段
kb ingest keep <頁面代號>      更新來源時：這一頁看過了，不用改
（AI 直接在 wiki/ 新增或修改頁面）
kb ingest commit               檢查全部頁面；通過才更新索引、對應表、log，並做成一筆 commit
kb ingest status               顯示目前處理到哪裡
kb ingest abort                放棄這一份，把 wiki/ 還原到上一次 commit
```

- 一次處理一份來源，一份來源一筆 commit。
- AI 只寫 `wiki/` 的頁面。`index.md`、`log.md`、`.kb/` 只由 `kb` 寫入，被手動改過時 `kb ingest commit` 會擋下。
- 驗證沒過就不會 commit。錯誤訊息固定包含：哪裡不合格、正確寫法、下一步。
- `raw/` 只收文字檔。PDF、Office 檔要先用其他工具轉成 markdown（轉檔工具另案開發，不在這個專案內）。
- 來源帶圖片時，把轉檔輸出的 `.md` 與圖片資料夾（例如 `screenshot/`）整包放進 `raw/` 即可。`kb ingest start` 會把該 `.md` 引用到的圖片搬到 `assets/<來源檔名>/`，並把 `.md` 內的圖片路徑改寫成 `assets/…`。
- 已處理過的來源不可修改。來源有新版時覆蓋原檔，`kb ingest start` 會把它列為「內容有更新」。

### 來源有新版時

覆蓋 `raw/` 裡的原檔，再執行 `kb ingest start <來源檔>`。它會比對新舊版，只列出變動的部分，不用整份重讀：

- **來源的變更**：舊版拿掉的行與新版加入的行。
- **需要檢查的頁面**：引用的章節或行數範圍內容有變的頁面。每一頁要嘛修改，要嘛用 `kb ingest keep <頁面代號>` 聲明看過了不用改，否則 `kb ingest commit` 會擋下。
- **已自動調整行數的頁面**：引用的內容沒變，只是因為前面增刪而移了位置。`kb` 直接把頁面裡的 `:L起-L迄` 改成新的行數，不需要 AI 處理。這是 `kb` 唯一會修改 `wiki/` 頁面內容的情況。
- **新增的內容**：新版多出來、還沒有任何頁面引用的部分，由 AI 判斷要不要新增頁面。

內容有變的行數引用也會先對應到新版的位置，再交給 AI 檢查。改動幅度太大（變動的行數超過一半，或差異超過 400 行）時不比對，照一般流程整份重新處理。
- 單張圖片上限 1 MB，超過會擋下。

### 修改、檢查、撤銷

```
kb commit "<說明>"     commit 與來源無關的頁面修改（修錯字、補關鍵字、修 lint 問題）
kb lint                完整檢查
kb test                執行檢索測試
kb test add --terms "<關鍵字,關鍵字>" --expect <頁面代號> [--rank <名次>]
kb test remove <題號>
kb undo                撤銷最近一次 ingest 或 commit
kb rebuild             重新產生 index.md 與搜尋索引
```

- `kb lint` 檢查：格式錯誤、斷連結、來源引用失效、孤立頁面、標題重複、尚未處理或處理後有更新的來源、
  沒被引用的來源、沒用到的圖片、檢索測試。內容是否矛盾或過時需要 AI 讀頁面判斷，流程寫在維護 skill 裡。
- 檢索測試（`.kb/query-tests.json`）每題是「用這些關鍵字搜尋時，這些頁面要排在前 N 名」。
  不需要 LLM，每次 `kb ingest commit` 與 `kb commit` 前自動執行，沒過就不 commit。
- `kb undo` 會新增一筆反向的 commit，不改寫歷史，所以已經推到共享資料夾的變更也能撤銷。
  可以連續執行，一次退一筆。撤銷 ingest 後來源檔仍留在 `raw/`，回到待處理狀態。
- `log.md` 只增不改：撤銷時原本的紀錄保留，另外附加一筆 undo。

### 共享知識庫

沒有 git server 也能共享：在共享資料夾上放一個純儲存用的 git 儲存庫（bare repo），以檔案路徑存取。
維護者在本機的工作複本作業，完成後推上去；使用者的 MCP 從那裡更新本機快取。

```
kb share <共享資料夾>/<代號>.git     第一次共享：建立儲存庫並推送，輸出使用者要執行的 kb mount add 指令
kb push                             把本機的變更推到共享位置
kb pull                             取得別人推送的變更
kb clone <共享路徑> <本機資料夾>     其他維護者取得工作複本
```

- 作業習慣：開始前 `kb pull`，完成後 `kb push`。
- 別人推送了新變更時，`kb ingest start` 與 `kb push` 會要求先 `kb pull`。
- 兩位維護者各自做了變更、誰都還沒取得對方的版本時，**不會自動合併**：索引、對應表、log 是產生出來的檔案，
  兩邊同時修改一定衝突。`kb pull` 會說明處理方式（撤銷本機變更、取得對方版本、重新 ingest）。
- 共享資料夾的路徑只存在維護者的 git 設定與使用者的 MCP 設定檔，不會寫進知識庫內容。
- 誰能寫入由共享資料夾的權限決定。`kb.json` 的機密等級是防止誤用的檢查，不是存取控制。

`.kb/provenance.json` 記錄每份來源的 hash、受它影響的頁面、歷次 ingest。每次 ingest 有一個 id，同時寫在 commit 訊息裡，
用 `git log --grep <id>` 可以找到對應的 commit。

## kb CLI 的查詢與檢查指令

在知識庫資料夾內執行，或加上 `--kb <路徑>`。

```
node <repo>/src/cli/kb.js check                    檢查整個知識庫
node <repo>/src/cli/kb.js validate <頁面檔>        檢查單一頁面
node <repo>/src/cli/kb.js rebuild                  重新產生 index.md 與搜尋索引
node <repo>/src/cli/kb.js search <關鍵字...>       搜尋頁面
node <repo>/src/cli/kb.js search --grep <樣式>     用 regex 逐行比對頁面；加 --scope raw 比對原始來源檔
node <repo>/src/cli/kb.js info                     顯示知識庫名片
node <repo>/src/cli/kb.js resolve <來源引用>       顯示來源引用所指的內容
```

## 知識庫格式摘要

```
<知識庫>/
  kb.json      說明檔
  raw/         原始來源（文字檔；隨附的圖片在 ingest 時搬到 assets/）
  wiki/        頁面：wiki/<分類>/<名稱>.md
  assets/      圖片
  SCHEMA.md    給維護 AI 的規則（分類方式、領域用語，維護者可調整）
  index.md     目錄（腳本產生）
  log.md       操作紀錄（腳本附加）
  .kb/         搜尋索引、來源與頁面對應表、檢索測試題（腳本產生）
```

- 頁面代號：`分類/名稱`，都用小寫英數加連字號。中文放在 `title`。
- 連結：`[[分類/名稱]]`、`[[分類/名稱|顯示文字]]`、`[[知識庫代號:分類/名稱]]`。
- 路徑一律從知識庫根目錄寫起：`raw/spec.md`、`assets/xxx.png`。
- 來源引用要寫到位置：`raw/spec.md#3.2`（章節編號或標題）、`raw/drv.c:L120-L180`（行數）。
- 檔案一律 UTF-8（無 BOM）加 LF 換行。

實際範例見 [examples/sample-kb](examples/sample-kb)。

## 專案結構

```
src/core/   核心函式庫：解析、驗證、索引、搜尋
src/cli/    kb CLI
src/mcp/    wiki MCP server
src/templates/  頁面範本與 SCHEMA.md 範本
skills/     給 AI agent 的 skill（SKILL.md）
examples/   範例知識庫
test/       單元測試與 MCP 端到端測試
```
