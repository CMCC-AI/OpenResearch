import type { LitSource } from "./orxCommand";

export const literatureSources: { id: LitSource; name: string; description: string; url: string }[] = [
  { id: "alphaxiv", name: "alphaXiv", description: "发现 arXiv 论文、社区评价与全文相关片段。", url: "https://www.alphaxiv.org/" },
  { id: "openalex", name: "OpenAlex", description: "覆盖跨学科论文、作者、机构与引用关系。", url: "https://openalex.org/" },
  { id: "biorxiv", name: "bioRxiv", description: "聚焦生命科学预印本，通过 OpenAlex 检索相关文献。", url: "https://www.biorxiv.org/" },
  { id: "pubmed", name: "PubMed", description: "通过 NCBI 检索生物医学与生命科学文献、摘要及原文链接。", url: "https://pubmed.ncbi.nlm.nih.gov/" },
];

// These entries open the publisher's search; they are not API search adapters.
export const externalLiteratureSources = [
  { id: "ieee", name: "IEEE Xplore", description: "面向电子、电气、通信与计算机等领域，提供期刊论文、会议论文及技术标准。", url: "https://ieeexplore.ieee.org/" },
  { id: "cnki", name: "中国知网（CNKI）", description: "中文学术文献平台，覆盖期刊论文、学位论文和会议论文等资源。", url: "https://www.cnki.net/" },
] as const;
