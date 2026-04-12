# DESIGN.md — Coinbase-Inspired Design System

> For: CEX-CEX 资金费率套利管理平台
> Inspired by: Coinbase Design System (CDS)
> Theme: 信任、清晰、专业、数据密集型金融工具

---

## 1. Visual Theme & Atmosphere

**Mood**: 机构级金融工具。干净、可信赖、专业但不冰冷。传达"你的资金在安全的系统里"的感觉。

**Design Philosophy**:
- 信息密度优先 — 交易管理平台需要一屏展示大量数据，不浪费空间
- 克制装饰 — 没有多余的渐变、动画或插图，数据就是界面
- 留白有节奏 — 模块之间有呼吸感，模块内部紧凑
- 暗色主题为主 — 交易类产品标配，长时间使用护眼

**Density**: 中高密度。表格行高紧凑，卡片间距适中。

---

## 2. Color Palette

### Primary Colors

| Token | Hex | Role |
|-------|-----|------|
| `blue-primary` | `#1652F0` | 品牌主色，主要按钮、链接、活跃状态 |
| `blue-hover` | `#1244C4` | 主色悬停态 |
| `blue-muted` | `#1652F01A` | 主色低透明度背景（10%） |

### Semantic Colors

| Token | Hex | Role |
|-------|-----|------|
| `positive` | `#00D180` | 盈利、做多、正费率、成功 |
| `positive-hover` | `#00B36B` | 正向色悬停 |
| `positive-muted` | `#00D1801A` | 正向低透明度背景 |
| `negative` | `#FF3B30` | 亏损、做空、负费率、错误 |
| `negative-hover` | `#D93229` | 负向色悬停 |
| `negative-muted` | `#FF3B301A` | 负向低透明度背景 |
| `warning` | `#FFC801` | 告警、保证金预警 |
| `warning-muted` | `#FFC8011A` | 告警低透明度背景 |

### Dark Theme Surfaces

| Token | Hex | Role |
|-------|-----|------|
| `bg-primary` | `#0A0B0D` | 页面主背景 |
| `bg-secondary` | `#111214` | 卡片/面板背景 |
| `bg-tertiary` | `#1A1B1F` | 输入框、表格行悬停、次级面板 |
| `bg-hover` | `#22232A` | 通用悬停背景 |
| `border-primary` | `#2A2B33` | 主要边框 |
| `border-secondary` | `#1E1F25` | 次要边框（分割线） |

### Text Colors

| Token | Hex | Role |
|-------|-----|------|
| `text-primary` | `#F5F5F7` | 主要文字 |
| `text-secondary` | `#8A8F98` | 次要文字、标签、说明 |
| `text-tertiary` | `#5B5E66` | 占位符、禁用文字 |
| `text-on-blue` | `#FFFFFF` | 蓝色按钮上的文字 |

---

## 3. Typography

**Font Family**: `"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`

> Inter 是开源字体中最接近 Coinbase Sans 几何风格的选择，且 Next.js 原生支持。

**Monospace (数据)**: `"JetBrains Mono", "SF Mono", "Fira Code", monospace`

> 费率、价格、金额等数字数据使用等宽字体，保证列对齐。

### Type Scale

| Token | Size | Weight | Line Height | 用途 |
|-------|------|--------|-------------|------|
| `display` | 32px | 600 | 1.2 | 页面标题 |
| `headline` | 24px | 600 | 1.3 | 卡片标题、Section 标题 |
| `subheadline` | 18px | 500 | 1.4 | 次级标题 |
| `body` | 14px | 400 | 1.5 | 正文、表格内容 |
| `body-medium` | 14px | 500 | 1.5 | 强调正文 |
| `label` | 12px | 500 | 1.4 | 表头、标签、badge |
| `caption` | 11px | 400 | 1.4 | 时间戳、辅助说明 |
| `data` | 14px | 500 | 1.3 | 数字数据（等宽字体） |
| `data-large` | 20px | 600 | 1.2 | 大数字展示（总资产等） |

---

## 4. Component Styles

### Buttons

```
Primary:
  background: #1652F0
  color: #FFFFFF
  border-radius: 8px
  padding: 10px 20px
  font: 14px/500
  hover: #1244C4
  disabled: opacity 0.4

Secondary:
  background: transparent
  color: #F5F5F7
  border: 1px solid #2A2B33
  border-radius: 8px
  padding: 10px 20px
  hover: bg #22232A

Danger:
  background: #FF3B30
  color: #FFFFFF
  border-radius: 8px
  hover: #D93229

Ghost:
  background: transparent
  color: #8A8F98
  padding: 8px 12px
  hover: color #F5F5F7
```

### Cards

```
background: #111214
border: 1px solid #2A2B33
border-radius: 12px
padding: 20px
```

内部间距: 内容之间 `12px`，Section 之间 `16px`

### Tables

```
Header:
  background: #111214
  color: #8A8F98
  font: label (12px/500)
  text-transform: uppercase
  letter-spacing: 0.5px
  padding: 10px 16px
  border-bottom: 1px solid #2A2B33

Row:
  background: transparent
  color: #F5F5F7
  font: body (14px/400)
  padding: 12px 16px
  border-bottom: 1px solid #1E1F25
  hover: bg #1A1B1F

数字列: 右对齐，等宽字体
正值: color #00D180
负值: color #FF3B30
```

### Inputs

```
background: #1A1B1F
border: 1px solid #2A2B33
border-radius: 8px
color: #F5F5F7
padding: 10px 14px
font: body (14px)
placeholder: #5B5E66
focus: border-color #1652F0, box-shadow 0 0 0 3px #1652F01A
```

### Badges / Tags

```
Positive: bg #00D1801A, color #00D180, border-radius 6px, padding 2px 8px
Negative: bg #FF3B301A, color #FF3B30
Warning:  bg #FFC8011A, color #FFC801
Neutral:  bg #1A1B1F,   color #8A8F98
Blue:     bg #1652F01A,  color #1652F0
```

### Sidebar Navigation

```
background: #0A0B0D
width: 240px
border-right: 1px solid #1E1F25

Nav Item:
  padding: 8px 16px
  border-radius: 8px
  color: #8A8F98
  font: body-medium (14px/500)
  hover: bg #1A1B1F, color #F5F5F7
  active: bg #1652F01A, color #1652F0
```

---

## 5. Layout & Spacing

### Grid

```
Sidebar (fixed): 240px
Main content: 1fr
Max content width: 1200px (within main area)
Page padding: 24px
```

### Spacing Scale (8px base)

| Token | Value |
|-------|-------|
| `space-0` | 0px |
| `space-0.5` | 4px |
| `space-1` | 8px |
| `space-1.5` | 12px |
| `space-2` | 16px |
| `space-3` | 24px |
| `space-4` | 32px |
| `space-6` | 48px |
| `space-8` | 64px |

### Layout Rules

- 卡片之间间距: `16px`
- 卡片内 section 间距: `16px`
- 表单元素间距: `12px`
- 页面标题到内容: `24px`
- Sidebar nav item 间距: `4px`

---

## 6. Depth & Elevation

暗色主题下，用边框和背景层级区分深度，而非阴影。

| Level | Surface | Border | Usage |
|-------|---------|--------|-------|
| 0 | `#0A0B0D` | — | 页面背景 |
| 1 | `#111214` | `#2A2B33` | 卡片、面板 |
| 2 | `#1A1B1F` | `#2A2B33` | 弹窗、下拉菜单、嵌套面板 |
| 3 | `#22232A` | `#2A2B33` | Tooltip、浮动操作 |

**唯一使用阴影的场景**: 弹窗 (Dialog / Modal)
```
box-shadow: 0px 8px 24px rgba(0, 0, 0, 0.4)
```

---

## 7. Do's and Don'ts

### Do's ✓
- 数字数据使用等宽字体，保证列对齐
- 盈利/亏损严格用绿/红，不要用其他颜色
- 表格数字右对齐
- 状态变化用 badge 颜色区分，不依赖文字
- 关键操作（开仓、平仓）需二次确认弹窗
- 金额显示保留合理精度（USDT 2位，BTC 6位，费率 4位小数+%）

### Don'ts ✗
- 不用渐变色做背景（按钮和文字都不用）
- 不用圆形按钮（统一 8px border-radius）
- 不在数据密集区域使用动画
- 不用纯白 `#FFFFFF` 做暗色主题的文字（用 `#F5F5F7`，降低刺眼感）
- 不让状态仅靠颜色区分（需搭配图标或文字）
- 不在表格里用大段文字，保持简洁

---

## 8. Responsive Behavior

| Breakpoint | Width | Behavior |
|------------|-------|----------|
| `desktop` | ≥1024px | 完整 sidebar + main content |
| `tablet` | 768-1023px | sidebar 收缩为 icon-only (64px) |
| `mobile` | <768px | sidebar 变为底部 tab bar，表格横向滚动 |

### Touch Targets
- 最小点击区域: 44×44px
- 移动端按钮最小高度: 48px

### Data Tables on Mobile
- 关键列固定，次要列横向滚动
- 或切换为卡片列表视图

---

## 9. Agent Prompt Guide

### Quick Color Reference
```
Brand Blue:    #1652F0
Profit Green:  #00D180
Loss Red:      #FF3B30
Warning Gold:  #FFC801
Background:    #0A0B0D
Card Surface:  #111214
Text Primary:  #F5F5F7
Text Muted:    #8A8F98
Border:        #2A2B33
```

### Ready-to-Use Prompts

**Dashboard 页面**: "Build a dark-theme financial dashboard with #0A0B0D background. Use cards (#111214) with #2A2B33 borders for each metric block. Display profit in #00D180 and loss in #FF3B30. Use Inter for labels and JetBrains Mono for numbers. Keep 8px grid spacing."

**Data Table**: "Create a data table with #111214 header background, #8A8F98 uppercase column labels at 12px, body rows at 14px in #F5F5F7. Numbers right-aligned in monospace. Row hover #1A1B1F. Positive values #00D180, negative #FF3B30."

**Action Confirmation Dialog**: "Dark modal with #1A1B1F background, 12px border-radius, 24px padding. Title in 18px/500 #F5F5F7. Details in 14px/400 #8A8F98. Primary action button in #1652F0, cancel button in transparent with #2A2B33 border. Shadow: 0px 8px 24px rgba(0,0,0,0.4)."
