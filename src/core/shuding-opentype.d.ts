declare module '@shuding/opentype.js' {
  interface OpenTypeFont {
    getAdvanceWidth(
      text: string,
      fontSize: number,
      options?: { kerning?: boolean; letterSpacing?: number },
    ): number;
  }

  const opentype: {
    parse(data: ArrayBuffer): OpenTypeFont;
  };

  export default opentype;
}
