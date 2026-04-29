# 少女終末プディング レシピ図鑑 / Girls Pudding Cookbook

静的な Web アプリ — 生ファイル (`DumpAssets/`) からビルドした小さな JSON を読み、ポラロイド風の画像カードでレシピ図鑑を表示します。

## 機能

- **セーブファイル読込**: `app-save.json` から「作ったレシピ」と「現在の手持ち食材」を抽出します。
- **手動トグル**: カードをクリックすると「作成済み／未作成」を切替できます。
- **自動ソート**: 「作れる (手持ちで今すぐ作れる) → 未作成 (材料が足りない) → 作成済み」の順で並びます。
- **インベントリ編集**: 左ペインの素材枠を左クリックで +1、右クリックで −1。手持ちだけど現状どのレシピにも不要な素材は赤く点滅しタグ表示。
- **ハイライト**: レシピカードの材料スロットに手持ちの素材がある場合は緑枠で強調します。`<fish>` のような任意カテゴリスロットも対応。
- **言語切替**: 日本語 / English / 简体中文 / 繁體中文。
- **進捗は localStorage に自動保存** されます（ブラウザを閉じても残ります）。

## ディレクトリ

```
GirlsPuddingCookbook/
├── build/
│   └── build.mjs        # DumpAssets → public/data + public/assets の変換スクリプト
└── public/
    ├── index.html
    ├── style.css
    ├── app.js
    ├── assets/
    │   ├── ui/          (polaroid.png, item_slot.png)
    │   ├── cookings/    (cooking*.png)
    │   ├── ingredients/ (food*.png)
    │   └── tools/       (空: 道具の画像はダンプに無いため名前のみ表示)
    └── data/
        ├── recipes.json
        └── i18n.json
```

## セットアップ

```bash
# 1. リポジトリのルート（DumpAssets と同じ階層）で:
node GirlsPuddingCookbook/build/build.mjs

# 2. 静的配信（Python 使える場合）:
cd GirlsPuddingCookbook/public
python -m http.server 8080

# 3. ブラウザで http://localhost:8080 を開く
```

Node 版でのサーブ:

```bash
npx --yes http-server GirlsPuddingCookbook/public -p 8080
```

## データ周り

- `build.mjs` は `DumpAssets/MonoBehaviour/ItemBank.json` を **正規表現で** パースします — m_PathID が 63-bit で JS の `Number` 安全範囲を超えるため、文字列で取り出して対応するテクスチャ PNG を突き合わせます。
- 1 件だけ (`cooking12`) ダンプ時に桁落ちした pathID があるので、末尾の 1 桁を削って fuzzy match するフォールバックも入れています。
- `tool00..tool08` の PNG はダンプに含まれていない（AssetBundle 別管理の疑い）ため、道具はカード上で名前のみ表示しています。

## ライセンスに関する注記

`DumpAssets/` 由来の画像・テキストはゲーム「少女終末プディング」の著作物です。本ツール自体は学習目的の図鑑ビューアで、再配布する場合は当該ゲームの利用規約に従ってください。
