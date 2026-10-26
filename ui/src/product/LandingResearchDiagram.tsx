import { landingAsset } from "./landingAssets";
const diagrams = [
  {
    name: "harness",
    alt: "科研 Harness：项目上下文连接研究计划、工具调用、实验执行与结果核验，异常时从检查点诊断与恢复。",
  },
  {
    name: "feedback",
    alt: "反馈驱动：实验行动、结果评测、反馈分析、方案修订通过顺时针箭头组成完整循环。",
  },
  {
    name: "collaboration",
    alt: "人机协同：研究者参与确定研究假设、确认资源投入与审查结果解释，科研智能体承接执行。",
  },
  {
    name: "evidence",
    alt: "版本与证据：从研究结论沿连线追溯到实验运行、代码版本、科学数据、实验配置与文献来源。",
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
