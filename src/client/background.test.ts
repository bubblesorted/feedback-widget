// @vitest-environment jsdom
/** The background a picked element is drawn on: the one behind it on screen (ARI-887). */
import { afterEach, expect, it } from "vitest";

import { backgroundBehind } from "./panel";

afterEach(() => {
  document.body.innerHTML = "";
  document.body.style.backgroundColor = "";
});

it("uses the nearest opaque ancestor, not the page", () => {
  document.body.style.backgroundColor = "rgb(71, 84, 59)";
  document.body.innerHTML = '<section style="background-color: rgb(233, 233, 223)"><div><h1 id="t">A</h1></div></section>';
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(233, 233, 223)");
});

it("composites translucent backgrounds over the opaque one behind them", () => {
  document.body.style.backgroundColor = "rgb(20, 20, 20)";
  document.body.innerHTML = '<section style="background-color: rgba(255, 255, 255, 0.1)"><h1 id="t">A</h1></section>';
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(44, 44, 44)");
});

it("composites over white when nothing behind is opaque", () => {
  document.body.innerHTML = '<section style="background-color: rgba(0, 0, 0, 0.5)"><h1 id="t">A</h1></section>';
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(128, 128, 128)");
});

it("continues through a shadow root's host", () => {
  document.body.style.backgroundColor = "rgb(10, 10, 10)";
  document.body.innerHTML = '<div id="host"></div>';
  const root = document.getElementById("host")!.attachShadow({ mode: "open" });
  root.innerHTML = '<h2 id="t">A</h2>';
  expect(backgroundBehind(root.getElementById("t")!)).toBe("rgb(10, 10, 10)");
});

it("white when nothing has a background", () => {
  document.body.innerHTML = '<h1 id="t">A</h1>';
  expect(backgroundBehind(document.getElementById("t")!)).toBe("#ffffff");
});

it("skips display: contents ancestors, which paint no background", () => {
  document.body.style.backgroundColor = "rgb(10, 10, 10)";
  document.body.innerHTML = '<div style="display: contents; background-color: rgb(250, 0, 0)"><h1 id="t">A</h1></div>';
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(10, 10, 10)");
});

it("follows a slotted element through its slot", () => {
  document.body.style.backgroundColor = "rgb(10, 10, 10)";
  document.body.innerHTML = '<div id="host"><h2 id="t" slot="s">A</h2></div>';
  const root = document.getElementById("host")!.attachShadow({ mode: "open" });
  root.innerHTML = '<div style="background-color: rgb(200, 200, 200)"><slot name="s"></slot></div>';
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(200, 200, 200)");
});

it("skips an ancestor whose box does not cover the element (a fixed element outside its header)", () => {
  document.body.style.backgroundColor = "rgb(10, 10, 10)";
  document.body.innerHTML = '<header id="h" style="background-color: rgb(255, 255, 255)"><p id="t">A</p></header>';
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
  document.getElementById("h")!.getBoundingClientRect = () => rect(0, 0, 800, 80);
  document.getElementById("t")!.getBoundingClientRect = () => rect(0, 700, 200, 40);
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(10, 10, 10)");
  document.getElementById("t")!.getBoundingClientRect = () => rect(0, 20, 200, 40);
  expect(backgroundBehind(document.getElementById("t")!)).toBe("rgb(255, 255, 255)");
});
