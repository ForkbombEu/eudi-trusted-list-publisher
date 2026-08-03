/**
 * The XML operations an enveloped signature needs: parsing, Exclusive XML
 * Canonicalisation of a document or a subtree, and locating elements by Id.
 *
 * Everything canonicalises from a serialized document, never from a tree the
 * caller has been mutating, so the signer and a verifier see the same bytes.
 */
import { XmlC14NMode, XmlDocument, type XmlElement } from "libxml2-wasm";
import { NS_DSIG } from "./algorithms.js";

export class XmlSecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlSecError";
  }
}

export function parseXml(xml: string): XmlDocument {
  try {
    return XmlDocument.fromString(xml);
  } catch (error) {
    throw new XmlSecError(
      `The document is not well-formed XML: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

const EXCLUSIVE = { mode: XmlC14NMode.XML_C14N_EXCLUSIVE_1_0 } as const;

/** Exclusive canonicalisation of a whole document. */
export function canonicalizeDocumentExclusive(document: XmlDocument): Buffer {
  return Buffer.from(document.canonicalizeToString(EXCLUSIVE), "utf-8");
}

/** Exclusive canonicalisation of one element and its descendants. */
export function canonicalizeElementExclusive(element: XmlElement): Buffer {
  return Buffer.from(element.canonicalizeToString(EXCLUSIVE), "utf-8");
}

/**
 * Exclusive canonicalisation of a document with the `ds:Signature` element
 * omitted — the enveloped-signature transform of XMLDSig clause 6.6.4.
 *
 * The transform is a visibility filter rather than a deletion, so the document
 * is never modified in order to be measured. The filter is structural
 * (`ds:Signature` by name and namespace) rather than by node identity:
 * libxml2-wasm hands the callback a freshly built wrapper for each visit, so
 * two wrappers for the same node are not the same JavaScript object and a Set
 * of them would match nothing. libxml2 cascades invisibility to the children of
 * a node the callback rejected, so rejecting the element removes its whole
 * subtree.
 *
 * A document carrying more than one signature is refused by the caller; here
 * every `ds:Signature` would be omitted, which is only correct when there is
 * exactly one.
 */
export function canonicalizeWithoutSignature(document: XmlDocument): Buffer {
  return Buffer.from(
    document.canonicalizeToString({
      ...EXCLUSIVE,
      isVisible: (node) =>
        !(
          isElement(node) &&
          node.name === "Signature" &&
          node.namespaceUri === NS_DSIG
        ),
    }),
    "utf-8",
  );
}

function isElement(node: unknown): node is XmlElement {
  return (
    typeof node === "object" &&
    node !== null &&
    "firstChild" in node &&
    "attrs" in node
  );
}

/**
 * Finds an element by its `Id` attribute.
 *
 * `//*[@Id='…']` rather than XPath's `id()` on purpose: `id()` resolves only
 * IDs a DTD or schema declared, and a Trusted List is parsed without either.
 */
export function elementById(
  document: XmlDocument,
  id: string,
): XmlElement | null {
  if (!/^[A-Za-z_][\w.-]*$/.test(id))
    throw new XmlSecError(`'${id}' is not a usable XML Id.`);
  const node = document.get(`//*[@Id='${id}']`);
  return node && isElement(node) ? node : null;
}

/** The document element's qualified name, as written in the serialized form. */
export function rootElementName(document: XmlDocument): string {
  const root = document.root;
  const prefix = root.namespacePrefix;
  return prefix ? `${prefix}:${root.name}` : root.name;
}

/**
 * Inserts a serialized element as the last child of the document element.
 *
 * The root's end tag is by definition the last markup in a well-formed
 * document, so splicing before it appends to the root. Working on the text
 * keeps the rest of the document byte-identical, which matters: the first
 * `ds:Reference` is a digest over exactly those bytes' canonical form.
 */
export function appendToRoot(
  xml: string,
  rootName: string,
  fragment: string,
): string {
  const endTag = `</${rootName}>`;
  const at = xml.lastIndexOf(endTag);
  if (at === -1)
    throw new XmlSecError(
      `The document has no '${endTag}' end tag, so there is nothing to append to.`,
    );
  const indent = "  ";
  return `${xml.slice(0, at)}${indent}${fragment.replace(
    /\n/g,
    `\n${indent}`,
  )}\n${xml.slice(at)}`;
}
