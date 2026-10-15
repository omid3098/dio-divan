// A name the person gave (an agent, a Library entry), put inside a Persian sentence: isolated, so that Latin letters in it do not turn
// the quotation marks around it (Dio Docs RTL-7). Added when the sentence is drawn and never stored (RTL-8). English text needs none.

const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

/** First-strong isolate: the name takes the direction of its own first letter, and the sentence around it keeps its own. */
export const isolate = (text: string, lang: string): string =>
  lang === 'fa' ? `${FSI}${text}${PDI}` : text;
