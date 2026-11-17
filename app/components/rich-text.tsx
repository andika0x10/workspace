import { Fragment, type ReactNode } from "react";
import { safeHref, type RichNode } from "../../lib/model";
export function RichText({ node }: { node: RichNode }) {
  let content: ReactNode = node.type === "text" ? node.text : node.content?.map((child, i) => <RichText key={i} node={child} />);
  for (const [i, mark] of (node.marks ?? []).entries()) {
    if (mark.type === "bold") content = <strong key={i}>{content}</strong>;
    if (mark.type === "italic") content = <em key={i}>{content}</em>;
    if (mark.type === "link" && mark.attrs && safeHref(mark.attrs.href))
      content = (
        <a key={i} className="nodrag" href={mark.attrs.href} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()}>
          {content}
        </a>
      );
  }
  if (node.type === "paragraph") return <p>{content || <br />}</p>;
  if (node.type === "bulletList") return <ul>{content}</ul>;
  if (node.type === "listItem") return <li>{content}</li>;
  if (node.type === "hardBreak") return <br />;
  return <Fragment>{content}</Fragment>;
}
