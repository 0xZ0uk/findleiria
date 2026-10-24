import { describe, expect, test } from "bun:test";

import { stripTags, textOf } from "./html";

describe("stripTags", () => {
	test("removes tags, script and style bodies", () => {
		const out = stripTags(
			"<p>Olá</p><script>var x = '<b>'</script><style>p{}</style><b>mundo</b>",
		);
		expect(out.replace(/\s+/g, " ").trim()).toBe("Olá mundo");
	});

	test("leaves entities untouched (decoding is textOf's job)", () => {
		expect(stripTags("<b>Rock &amp; Roll</b>").trim()).toBe("Rock &amp; Roll");
	});
});

describe("textOf", () => {
	test("line breaks and block closings separate words", () => {
		expect(textOf("<p>um</p><p>dois</p>tres<br/>quatro<br>cinco")).toBe(
			"um dois tres quatro cinco",
		);
		expect(textOf("<li>a</li><li>b</li><h2>c</h2>d")).toBe("a b c d");
	});

	test("decodes through the canonical decoder and collapses whitespace", () => {
		expect(textOf("  <b>Rock &amp;\n Roll</b>   &#8211; &ecirc;xito ")).toBe(
			"Rock & Roll – êxito",
		);
	});

	test("hydration comments never leak into the text", () => {
		expect(textOf("<span>a<!-- -->b</span>")).toBe("a b");
	});

	test("empty in, empty out", () => {
		expect(textOf("")).toBe("");
		expect(textOf("<div> </div>")).toBe("");
	});
});
