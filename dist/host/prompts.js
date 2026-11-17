/**
 * Fixed prompts for the L2 AI summary (S18).
 *
 * The model must answer with a JSON array only — anything else is rejected and
 * the card keeps its L1 line.
 */
export const SYSTEM_PROMPT = [
    '你是一个帮助中文开发者发现开源项目的助手。',
    '你会收到一个 GitHub 仓库列表，需要为每个仓库写一句中文简介和一句推荐理由。',
    '要求：',
    '1. 只输出 JSON 数组，不要输出解释、不要输出 Markdown 代码块。',
    '2. 每个元素的字段固定为 fullName、zh、why。',
    '3. fullName 必须与输入的 fullName 完全一致，顺序保持一致。',
    '4. zh 是面向中文开发者的一句话说明，30 字以内，不要出现 URL、不要出现英文整句。',
    '5. why 说明「为什么值得看」，12 字以内，不要重复 zh 的内容。',
    '6. 不要编造输入里没有的能力；不确定就描述它的类型和用途。',
    '7. 输出必须完整闭合：最后一个字符是 ]，不要写「…」或省略号。',
].join('\n');
/** Build the user message for one batch (at most 5 repositories). */
export function buildUserPrompt(repos) {
    const list = repos.map((repo, index) => {
        const topics = repo.topics.length > 0 ? repo.topics.join(', ') : '无';
        return [
            `${index + 1}. fullName: ${repo.fullName}`,
            `   description: ${repo.description === '' ? '无' : repo.description}`,
            `   topics: ${topics}`,
            `   language: ${repo.language ?? '未知'}`,
            `   stars: ${repo.stars}`,
        ].join('\n');
    });
    return [
        `请为下面 ${repos.length} 个仓库各写一句中文简介。`,
        '',
        list.join('\n\n'),
        '',
        `只输出 JSON 数组，长度必须是 ${repos.length}。`,
    ].join('\n');
}
