# BetterBaha AI 分析回覆

`betterbaha-ai-reply.user.js` 是一支 Tampermonkey / Violentmonkey userscript，會在巴哈姆特討論區文章頁右上工具列加入「AI分析回覆」按鈕。

<img width="1852" height="1041" alt="image" src="https://github.com/user-attachments/assets/63c70dd3-303a-4efc-a336-daba9f3687e3" />

## 功能

- 在文章頁工具列的追蹤按鈕左側加入「AI分析回覆」
- 抓取文章標題與第一篇文章內文
- 呼叫你設定的 OpenAI 相容 Chat Completions API
- 產生可直接貼到回覆框的繁中草稿
- 草稿可複製，也可以帶到巴哈回覆頁並嘗試自動填入編輯器
- 進入回覆頁後，會嘗試勾選「此為 AI 創作」
- 
## 安裝

1. 安裝 Tampermonkey 或 Violentmonkey。
2. 新增 userscript。
3. 把 `betterbaha-ai-reply.user.js` 的內容貼上並儲存。
4. 打開巴哈文章頁

## 設計思路

回文但有時候寫太長人家不看，又浪費我自己時間

## 模型推薦

我是用OpenCode Zen的Free Model，因為回文智商不用太高，速度也不密集
