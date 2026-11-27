import { landingAsset } from "./landingAssets";
const diagrams = [
  {
    name: "harness",
    alt: "科研 Harness：项目上下文连接研究计划、工具调用、实验执行与结果核验，异常时从检查点诊断与恢复。",
  },
  {
    name: "feedback",
    alt: "RSI：把实验行动、结果评测、反馈分析与方案修订连成持续迭代闭环。",
  },
  {
    name: "collaboration",
    alt: "人机协同：AI 承接繁复执行，关键假设与决策由研究者亲自把关。",
  },
  {
    name: "evidence",
    alt: "可信科研：代码版本、运行日志、科学数据与研究结论全链路绑定溯源。",
  },
];
export function ResearchDiagram({ selected }: { selected: number }) {
  const { name, alt } = diagrams[selected];
  return (
    <img
      key={name}
      className="advantage-art restored-art"
      src={landingAsset(`advantage-${name}-labeled-1280.webp`)}
      srcSet={`${landingAsset(`advantage-${name}-labeled-640.webp`)} 640w, ${landingAsset(`advantage-${name}-labeled-1280.webp`)} 1280w`}
      sizes="(max-width:760px) 92vw, 65vw"
      width="1536"
      height="1024"
      alt={alt}
      loading="lazy"
      decoding="async"
    />
  );
}
