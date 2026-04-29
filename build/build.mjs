// build.mjs — convert DumpAssets into a small, web-friendly data set and copy textures.
//
// Reads:
//   ../../DumpAssets/MonoBehaviour/ItemBank.json
//   ../../DumpAssets/TextAsset/Lang-JP.txt
//   ../../DumpAssets/TextAsset/Trans-JP-{EN,ZHCN,ZHTW}.txt
//   ../../DumpAssets/Texture2D/*.png
//
// Writes:
//   ../public/data/recipes.json
//   ../public/data/i18n.json
//   ../public/assets/cookings/<id>.png
//   ../public/assets/ingredients/<id>.png
//   ../public/assets/ui/{polaroid.png,item_slot.png}
//
// NOTE on big integers: ItemBank.json pathIDs exceed JS safe-int range.
// We parse them as strings via regex so nothing rounds.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(__dirname, '..', 'public');
const TEX_DIR = path.join(ROOT, 'DumpAssets', 'Texture2D');
const TXT_DIR = path.join(ROOT, 'DumpAssets', 'TextAsset');
const ITEM_BANK = path.join(ROOT, 'DumpAssets', 'MonoBehaviour', 'ItemBank.json');

function readLangFile(file, hasTranslationColumn) {
  const raw = fs.readFileSync(file, 'utf8');
  const map = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line === '-') continue;
    const cells = line.split('\t');
    const key = cells[0];
    if (!key) continue;
    // Japanese file: key <TAB> jp
    // Translation file: key <TAB> jp <TAB> localized
    const value = hasTranslationColumn ? (cells[2] ?? cells[1] ?? '') : (cells[1] ?? '');
    map.set(key, value);
  }
  return map;
}

function parseItemBank() {
  const raw = fs.readFileSync(ITEM_BANK, 'utf8');
  // Each item block begins with `"_Comment"` and has `"_ID"`, `"_Image" { m_FileID, m_PathID }`, `"_Args": [...]`.
  // Pull with regex so we preserve m_PathID as a string (avoids 53-bit precision loss).
  // The structure of a block is stable enough to match conservatively.
  const blockRe = /"_Comment":\s*"([^"]*)",\s*"_Valid":\s*(-?\d+),\s*"_ID":\s*"([^"]+)",\s*"_Type":\s*(-?\d+),\s*"_Category":\s*"([^"]*)",\s*"_Tier":\s*(-?\d+),\s*"_Priority":\s*(-?\d+),\s*"_Image":\s*\{\s*"m_FileID":\s*-?\d+,\s*"m_PathID":\s*(-?\d+)\s*\}[\s\S]*?"_Args":\s*\[([\s\S]*?)\][\s\S]*?"_Effects":/g;
  const items = [];
  let m;
  while ((m = blockRe.exec(raw))) {
    const [, comment, valid, id, type, category, tier, priority, pathId, argsBody] = m;
    const args = [...argsBody.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
    items.push({
      id,
      comment,
      valid: Number(valid),
      type: Number(type),
      category,
      tier: Number(tier),
      priority: Number(priority),
      pathId,
      args,
    });
  }
  return items;
}

// Fuzzy match for pathIDs that lost a digit during texture export (one known case: cooking12).
function resolveTextureFile(pathId, availableSet) {
  if (availableSet.has(pathId)) return pathId;
  // Try removing one digit at a time from the end (lost-precision style)
  for (let i = pathId.length - 1; i >= (pathId.startsWith('-') ? 2 : 1); i--) {
    const shorter = pathId.slice(0, i) + pathId.slice(i + 1);
    if (availableSet.has(shorter)) return shorter;
  }
  return null;
}

function copyIfNeeded(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function main() {
  const items = parseItemBank();
  const jp = readLangFile(path.join(TXT_DIR, 'Lang-JP.txt'), false);
  const en = readLangFile(path.join(TXT_DIR, 'Trans-JP-EN.txt'), true);
  const zhcn = readLangFile(path.join(TXT_DIR, 'Trans-JP-ZHCN.txt'), true);
  const zhtw = readLangFile(path.join(TXT_DIR, 'Trans-JP-ZHTW.txt'), true);

  const textureFiles = new Set(
    fs.readdirSync(TEX_DIR).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4))
  );

  // 1. Build foods (food00..food14): id, category
  const foods = items
    .filter((it) => it.id.startsWith('food'))
    .map((it) => ({ id: it.id, category: it.category, pathId: it.pathId }));

  // 2. Build tools (tool00..tool08 mainly) - used only for display in recipes
  const tools = items
    .filter((it) => it.id.startsWith('tool') && /^tool\d{2}$/.test(it.id))
    .map((it) => ({ id: it.id, pathId: it.pathId }));

  // 3. Build recipes (cooking00..cooking30). The first arg is the tool, the rest are ingredient slots.
  const cookings = items.filter((it) => it.id.startsWith('cooking'));
  const recipes = cookings.map((it) => {
    const [tool, ...slots] = it.args;
    return {
      id: it.id,
      priority: it.priority,
      category: it.category,
      tool, // e.g. "tool01"
      ingredients: slots, // array of "food02" | "<fish>" | "<meat>|<vegetable>|<fish>" | "<any>"
      pathId: it.pathId,
    };
  });

  // 4. Copy textures we actually need
  const assetsDir = path.join(OUT, 'assets');
  fs.mkdirSync(path.join(assetsDir, 'cookings'), { recursive: true });
  fs.mkdirSync(path.join(assetsDir, 'ingredients'), { recursive: true });
  fs.mkdirSync(path.join(assetsDir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(assetsDir, 'ui'), { recursive: true });

  const missing = [];
  const copyByPath = (pathId, dstDir, nameBase) => {
    const key = resolveTextureFile(pathId, textureFiles);
    if (!key) {
      missing.push({ nameBase, pathId });
      return null;
    }
    const src = path.join(TEX_DIR, key + '.png');
    const dst = path.join(dstDir, nameBase + '.png');
    copyIfNeeded(src, dst);
    return nameBase + '.png';
  };

  for (const r of recipes) copyByPath(r.pathId, path.join(assetsDir, 'cookings'), r.id);
  for (const f of foods) copyByPath(f.pathId, path.join(assetsDir, 'ingredients'), f.id);
  for (const t of tools) copyByPath(t.pathId, path.join(assetsDir, 'tools'), t.id);

  copyIfNeeded(path.join(TEX_DIR, 'polaroid_2.png'), path.join(assetsDir, 'ui', 'polaroid.png'));
  copyIfNeeded(path.join(TEX_DIR, 'item_slot_01.png'), path.join(assetsDir, 'ui', 'item_slot.png'));

  if (missing.length) {
    console.warn('WARNING: failed to resolve textures for:', missing);
  }

  // 5. Build i18n map. Four languages — jp/en/zhcn/zhtw.
  const langs = { jp, en, zhcn, zhtw };
  const locales = {};
  for (const [code, table] of Object.entries(langs)) {
    const get = (key) => table.get(key) ?? jp.get(key) ?? key;
    const loc = { food: {}, cooking: {}, tool: {}, category: {} };
    for (const f of foods) loc.food[f.id] = get(`${f.id}-name`);
    for (const r of recipes) loc.cooking[r.id] = get(`${r.id}-name`);
    for (const t of tools) loc.tool[t.id] = get(`${t.id}-name`);
    for (const cat of ['milk', 'egg', 'meat', 'fish', 'vegetable', 'grain', 'seasoning', 'sweets']) {
      // Categories use the <..> placeholder in args — we'll store the localized label
      loc.category[cat] = (get(`category-${cat}`) || '').replace(/^\[|\]$/g, '');
    }
    locales[code] = loc;
  }

  // 6. UI strings that aren't in the game's language files
  const ui = {
    jp: {
      title: 'レシピ図鑑',
      subtitle: '少女終末プディング',
      importSave: 'セーブデータを読み込む',
      clearSave: '読み込みをリセット',
      inventory: '手持ちの食材',
      filterAll: 'すべて',
      filterMakeable: '作れる',
      filterNotMade: '未作成',
      filterMade: '作成済み',
      markMade: '作成済みにする',
      markUnmade: '未作成に戻す',
      anyIngredient: 'どれでも',
      ingredientsHeading: '材料',
      toolHeading: '道具',
      noRecipes: '該当するレシピはありません',
      importHint: 'app-save.json を選択してください',
      unusedTag: '未使用',
      madeStamp: '作成済み',
      languageLabel: '言語',
      inventoryHint: 'クリックで＋1／右クリックで−1',
      importModalTitle: 'セーブデータを開く',
      importModalBody: '下のフォルダパスをコピーし、続いて開くファイルダイアログのパス欄に貼り付け、その中の「app-save.json」を選択してください。',
      copyPath: 'コピー',
      copied: 'コピーしました',
      cancel: 'キャンセル',
      gotIt: '分かった',
      statsLabel: (done, total) => `${done} / ${total}`,
    },
    en: {
      title: 'Recipe Book',
      subtitle: 'Girls Made Pudding',
      importSave: 'Import save file',
      clearSave: 'Reset save import',
      inventory: 'Inventory',
      filterAll: 'All',
      filterMakeable: 'Makeable',
      filterNotMade: 'Not made',
      filterMade: 'Made',
      markMade: 'Mark as made',
      markUnmade: 'Mark as not made',
      anyIngredient: 'Any ingredient',
      ingredientsHeading: 'Ingredients',
      toolHeading: 'Tool',
      noRecipes: 'No recipes match the current filter',
      importHint: 'Pick app-save.json',
      unusedTag: 'Unused',
      madeStamp: 'Made',
      languageLabel: 'Language',
      inventoryHint: 'Click to +1 / right-click to -1',
      importModalTitle: 'Open save file',
      importModalBody: 'Copy the folder path below, paste it into the path field of the file dialog that opens next, then pick "app-save.json" inside.',
      copyPath: 'Copy',
      copied: 'Copied',
      cancel: 'Cancel',
      gotIt: 'Got it',
      statsLabel: (done, total) => `${done} / ${total}`,
    },
    zhcn: {
      title: '食谱图鉴',
      subtitle: '少女终末布丁',
      importSave: '导入存档文件',
      clearSave: '重置导入',
      inventory: '当前材料',
      filterAll: '全部',
      filterMakeable: '可制作',
      filterNotMade: '未制作',
      filterMade: '已制作',
      markMade: '标记为已做过',
      markUnmade: '标记为未做过',
      anyIngredient: '任意材料',
      ingredientsHeading: '所需材料',
      toolHeading: '所需器具',
      noRecipes: '没有符合当前条件的食谱',
      importHint: '请选择 app-save.json',
      unusedTag: '未使用',
      madeStamp: '已制作',
      languageLabel: '语言',
      inventoryHint: '左键 +1 / 右键 -1',
      importModalTitle: '打开存档文件',
      importModalBody: '请先复制下方的文件夹路径，在接下来弹出的文件选择对话框的路径栏中粘贴，然后选择里面的 "app-save.json" 文件。',
      copyPath: '复制',
      copied: '已复制',
      cancel: '取消',
      gotIt: '知道了',
      statsLabel: (done, total) => `${done} / ${total}`,
    },
    zhtw: {
      title: '食譜圖鑑',
      subtitle: '少女終末布丁',
      importSave: '匯入存檔',
      clearSave: '重設匯入',
      inventory: '目前材料',
      filterAll: '全部',
      filterMakeable: '可製作',
      filterNotMade: '未製作',
      filterMade: '已製作',
      markMade: '標記為已製作',
      markUnmade: '標記為未製作',
      anyIngredient: '任意材料',
      ingredientsHeading: '所需材料',
      toolHeading: '所需器具',
      noRecipes: '沒有符合當前條件的食譜',
      importHint: '請選擇 app-save.json',
      unusedTag: '未使用',
      madeStamp: '已製作',
      languageLabel: '語言',
      inventoryHint: '左鍵 +1 / 右鍵 -1',
      importModalTitle: '開啟存檔檔案',
      importModalBody: '請先複製下方的資料夾路徑，在接下來彈出的檔案選擇對話方塊的路徑欄中貼上，然後選擇裡面的「app-save.json」檔案。',
      copyPath: '複製',
      copied: '已複製',
      cancel: '取消',
      gotIt: '知道了',
      statsLabel: (done, total) => `${done} / ${total}`,
    },
  };

  // statsLabel is a function — convert to a small template string representation.
  // Simpler: drop it here and reconstruct in JS using language.statsLabel not needed — store format string.
  for (const code of Object.keys(ui)) {
    ui[code].statsLabel = '{done} / {total}';
  }

  // Merge ui into locales
  for (const code of Object.keys(locales)) {
    locales[code].ui = ui[code];
  }

  // Sort recipes by priority ascending so they match in-game order (for stable first render before user sort kicks in)
  recipes.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

  fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(OUT, 'data', 'recipes.json'),
    JSON.stringify({ foods, tools, recipes }, null, 2)
  );
  fs.writeFileSync(path.join(OUT, 'data', 'i18n.json'), JSON.stringify(locales, null, 2));
  console.log(
    `OK — recipes: ${recipes.length}, foods: ${foods.length}, tools: ${tools.length}, missing textures: ${missing.length}`
  );
}

main();
