// .srt files are often not Unicode: old ones use the Windows code page of their language.
// Codes of both engines: LibreTranslate (zh, zt, he) and Google (zh-CN, zh-TW, iw).
const LEGACY_ENCODINGS = {
  'windows-1250': ['pl', 'cs', 'sk', 'hu', 'ro', 'hr', 'sl', 'sq', 'bs'],
  'windows-1251': ['ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'ky', 'tg', 'mn'],
  'windows-1253': ['el'],
  'windows-1254': ['tr', 'az'],
  'windows-1255': ['he', 'iw', 'yi'],
  'windows-1256': ['ar', 'fa', 'ur', 'ps', 'ckb'],
  'windows-1257': ['lt', 'lv', 'et'],
  'windows-1258': ['vi'],
  'windows-874': ['th'],
  gb18030: ['zh', 'zh-CN', 'zh-Hans'],
  big5: ['zt', 'zh-TW', 'zh-Hant'],
  shift_jis: ['ja'],
  'euc-kr': ['ko'],
};

function legacyEncoding(bytes, lang) {
  const find = (code) => Object.keys(LEGACY_ENCODINGS).find((enc) => LEGACY_ENCODINGS[enc].includes(code));
  const known = find(lang) ?? find(lang.split('-')[0]);
  if (known) return known;
  if (lang !== 'auto') return 'windows-1252';
  // Russian text in cp1251 is mostly bytes above 0xBF, Western text in cp1252 has only a few accents
  let high = 0;
  let latin = 0;
  for (const b of bytes) {
    if (b > 0xbf) high++;
    else if ((b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a) latin++;
  }
  return high > latin / 2 ? 'windows-1251' : 'windows-1252';
}

// Unicode files decode right away (null otherwise), the rest waits for the source language
export function decodeUnicode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export const decodeLegacy = (bytes, lang) => new TextDecoder(legacyEncoding(bytes, lang)).decode(bytes);
