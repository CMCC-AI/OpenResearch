import { useState, type CSSProperties } from "react";
import { anthropicInsights } from "./landingContent";
import { landingAsset } from "./landingAssets";

export function AnthropicInsightsSection() {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { topics, footnote } = anthropicInsights;
  const active = topics[selectedIndex] ?? topics[0];

  return (
    <section
      className="section insights-section"
      id="insights"
      aria-labelledby="insights-title"
    >
      <div className="section-heading">
        <p className="eyebrow">AI FOR SCIENCE INSIGHTS</p>
        <h2 id="insights-title">洞察高频科研需求，构建核心能力底座</h2>
        <p className="section-description">
          超六成科研对话集中在科学数据分析与科学论文撰写，MobileSci 为此构建专属算子与智能体矩阵。
        </p>
      </div>

      <div className="insights-open-layout">
        <figure
          className="insights-open-chart"
          aria-labelledby="insights-chart-caption"
        >
          <figcaption id="insights-chart-caption" className="insights-chart-caption">
            <strong>研究者使用 AI 科研任务分布</strong>
            <span>按科研任务 Topic 占比（%）</span>
          </figcaption>

          <div
            className="insights-plot"
            role="group"
            aria-label="Anthropic 科研任务分布柱状图，展示科学数据分析 33.7%、科学论文撰写 32.0%、数据采集 11.5%、构思与假设 4.2%"
          >
            <div className="insights-gridlines" aria-hidden="true">
              <span>40%</span>
              <span>20%</span>
              <span>0%</span>
            </div>
            <div className="insights-columns">
              {topics.map((topic, index) => {
                const heightPct = Math.round((topic.share / 40) * 100);
                const isSelected = index === selectedIndex;
                return (
                  <div className="insights-column" key={topic.id}>
                    <div className="insights-bar-space">
                      <button
                        type="button"
                        className={`insights-vbar bar-${index}`}
                        style={{ "--bar-height": `${heightPct}%` } as CSSProperties}
                        aria-pressed={isSelected}
                        aria-label={`${topic.label} ${topic.share.toFixed(1)}%`}
                        onClick={() => setSelectedIndex(index)}
                        onMouseEnter={() => setSelectedIndex(index)}
                      >
                        <strong>
                          {topic.share.toFixed(1)}
                          <span>%</span>
                        </strong>
                      </button>
                    </div>
                    <span className="insights-xlabel">{topic.label}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="insights-chart-detail" role="status" aria-live="polite">
            <strong>
              {active.label} · {active.share.toFixed(1)}%
            </strong>
            <span>{active.note}</span>
          </div>
        </figure>

        <figure className="insights-artwork-frame">
          <img
            src={landingAsset("insights-capabilities-1280.webp")}
            srcSet={`${landingAsset("insights-capabilities-760.webp")} 760w, ${landingAsset("insights-capabilities-1280.webp")} 1280w`}
            sizes="(max-width: 960px) 92vw, 560px"
            width="1280"
            height="956"
            alt="MobileSci 高频能力矩阵：100+ 科学数据算子（数据清洗、统计检验、科研绘图）与 30+ Agents（文献精读、证据写作、独立审稿）"
            loading="lazy"
            decoding="async"
          />
        </figure>
      </div>

      <p className="insights-footnote">{footnote}</p>
    </section>
  );
}
