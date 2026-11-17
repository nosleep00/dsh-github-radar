// Local check of the L2 answer parser against a truncated model answer.
import { extractJsonArray, parseSummaryResponse } from '../dist/host/summarize.js'
import { chineseRatio, looksChinese } from '../dist/host/zh.js'

const raw = `[ { "fullName": "react-dropzone/react-dropzone", "zh": "基于 React 的简单 HTML5 文件拖拽上传组件", "why": "轻量易集成的上传方案" }, { "fullName": "OneDragon-Anything/ZenlessZoneZero-OneDragon", "zh": "绝区零全自动辅助`

console.log('extract:', JSON.stringify(extractJsonArray(raw)))
const zh = '基于 React 的简单 HTML5 文件拖拽上传组件'
console.log('ratio:', chineseRatio(zh), 'looksChinese:', looksChinese(zh, 0.3))
console.log(
  'parse:',
  JSON.stringify(
    parseSummaryResponse(raw, [
      { fullName: 'react-dropzone/react-dropzone', description: '', topics: [], language: null, stars: 1 },
      { fullName: 'OneDragon-Anything/ZenlessZoneZero-OneDragon', description: '', topics: [], language: null, stars: 1 },
    ]),
  ),
)
