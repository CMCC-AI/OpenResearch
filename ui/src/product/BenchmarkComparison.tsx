import { useState, type CSSProperties } from "react";
import { ArrowUpRight } from "lucide-react";
import { benchmarkComparison, benchmarkFields, benchmarkFieldNotes, benchmarkProducts } from "./benchmarkResults";

export function BenchmarkComparison() {
  const [visibleProducts, setVisibleProducts] = useState<string[]>(benchmarkProducts.map(row => row.name));
  const [selection, setSelection] = useState<{ product: number; field: number } | null>(null);
  const selected = selection ? benchmarkProducts[selection.product] : null;
  const toggleProduct = (name: string) => {
    setVisibleProducts(current => current.includes(name) ? current.length === 1 ? current : current.filter(item => item !== name) : [...current, name]);
    setSelection(null);
  };
  return (
    <section className="section benchmark-comparison" id="benchmark" aria-labelledby="benchmark-title">
      <div className="benchmark-comparison-top">
        <div className="benchmark-copy">
          <span className="eyebrow">RESEARCH, PUT TO THE TEST</span>
          <p className="benchmark-name">ResearchClawBench</p>
          <h2 id="benchmark-title">走进专业领域，<br />看见科研表现优势</h2>
          <p className="benchmark-lead">从规划、代码到实验验证，<br />在能源、生命科学与化学等领域，<br />MobileSci 展现更好的科研任务表现。</p>
          <a className="benchmark-source" href="https://internscience.github.io/ResearchClawBench-Home/" target="_blank" rel="noreferrer">查看公开评测 <ArrowUpRight size={15} /></a>
        </div>
        <figure className="benchmark-chart" aria-labelledby="benchmark-chart-title">
          <figcaption>
            <h3 id="benchmark-chart-title">专业领域，表现更优</h3>
            <div className="benchmark-legend" aria-label="选择展示产品">{benchmarkProducts.map((product, index) => <button type="button" key={product.name} aria-pressed={visibleProducts.includes(product.name)} onClick={() => toggleProduct(product.name)}><i className={`benchmark-swatch product-${index}`} />{product.name}</button>)}</div>
          </figcaption>
          <div className="benchmark-plot" role="group" aria-label="可交互领域表现图，各领域以 MobileSci 为100分基准，展示相对得分，越高越好">
            <div className="benchmark-grid" aria-hidden="true"><span>100</span><span>50</span><span>0</span></div>
            <div className="benchmark-columns">
              {benchmarkFields.map((field, fieldIndex) => (
                <div className="benchmark-column" key={field}>
                  <div className="benchmark-bar-space">{benchmarkProducts.map((product, productIndex) => visibleProducts.includes(product.name) && <button type="button" key={product.name} className={`benchmark-bar product-${productIndex}`} style={{ "--bar-height": `${product.values[fieldIndex]}%` } as CSSProperties} aria-label={`${field} · ${product.name} · 相对得分 ${product.values[fieldIndex].toFixed(1)}`} aria-pressed={selection?.product === productIndex && selection.field === fieldIndex} title={`${product.name}｜${field}：${product.values[fieldIndex].toFixed(1)}`} onClick={() => setSelection({ product: productIndex, field: fieldIndex })}><span className="benchmark-tooltip">{product.name}<strong>{product.values[fieldIndex].toFixed(1)}</strong></span></button>)}</div>
                  <span className="benchmark-product">{field}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="benchmark-chart-note">各领域以 MobileSci 为100分基准，展示相对得分，越高越好。</p>
          <div className="benchmark-selection" role="status" aria-live="polite">{selection && selected ? <><strong><i className={`benchmark-swatch product-${selection.product}`} />{selected.name} · {benchmarkFields[selection.field]}<span>{selected.values[selection.field].toFixed(1)}</span></strong><p>{benchmarkFieldNotes[selection.field]}</p></> : <><strong>点击柱形，探索各领域表现</strong><p>悬停查看数值，点击图例筛选产品。</p></>}</div>
        </figure>
      </div>
      <div className="benchmark-overall">
        <div className="benchmark-overall-label"><strong>综合表现提升</strong><span>平均评测得分相对提升</span></div>
        {benchmarkComparison.map(row => <div className="benchmark-metric" key={row.name}><span>vs {row.name}</span><strong>+{row.uplift.toFixed(1)}<small>%</small></strong></div>)}
      </div>
    </section>
  );
}
