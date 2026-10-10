import { XMLParser, XMLValidator } from "fast-xml-parser";

/** Parsed XML element: child elements are always arrays, attributes are "@_name", text is "#text". */
export type XNode = { [key: string]: XNode[] | string | undefined };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  alwaysCreateTextNode: true,
  isArray: (_name, _jpath, _leaf, isAttribute) => !isAttribute,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export function parseXml(text: string): XNode | null {
  if (XMLValidator.validate(text) !== true) return null;
  return parser.parse(text) as XNode;
}

export const kids = (n: XNode | undefined, name: string): XNode[] => (n?.[name] as XNode[] | undefined) ?? [];
export const kid = (n: XNode | undefined, name: string): XNode | undefined => kids(n, name)[0];
/** First match down a chain of child names, e.g. at(obs, "consumable", "manufacturedProduct"). */
export const at = (n: XNode | undefined, ...path: string[]): XNode | undefined => path.reduce<XNode | undefined>((c, p) => kid(c, p), n);
export const attr = (n: XNode | undefined, name: string): string | undefined => {
  const v = n?.[`@_${name}`];
  return typeof v === "string" && v !== "" ? v : undefined;
};
export const text = (n: XNode | undefined): string | undefined => {
  const v = n?.["#text"];
  return typeof v === "string" && v !== "" ? v : undefined;
};
export const hasTemplate = (n: XNode | undefined, root: string): boolean => kids(n, "templateId").some((t) => attr(t, "root") === root);
export const templates = (n: XNode | undefined): string[] => kids(n, "templateId").flatMap((t) => attr(t, "root") ?? []);
