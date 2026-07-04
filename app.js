const buttons = document.querySelectorAll("button");
const display = document.getElementById("display");
const htmlEl = document.documentElement;

let secondMode = false;
let isDegree = true;
let memory = 0;
let history = [];
let openParens = 0;   // tracks unclosed "(" (incl. auto-opened function parens)
let isLight = false;

const ERROR_MESSAGES = [
    "Math Error", "Invalid Input", "Incomplete Expression",
    "Undefined", "Cannot divide by zero", "Integers Only"
];

function getButtonByKey(key) {
    return [...buttons].find(button => button.dataset.key === key);
}

function isErrorMessage(str) {
    return ERROR_MESSAGES.includes(str);
}

function showError(message) {
    display.innerText = message;
    scrollDisplayToEnd();
}

function scrollDisplayToEnd() {
    requestAnimationFrame(() => { display.scrollLeft = display.scrollWidth; });
}

function toDegreesIfNeeded(radians) {
    return isDegree ? (radians * 180) / Math.PI : radians;
}

function toRadiansIfNeeded(value) {
    return isDegree ? (value * Math.PI) / 180 : value;
}

/* ---------------------------------------------------------------
   currentToken: returns the trailing "number in progress" so the
   decimal-point and EE guards only look at the number currently
   being typed, not the whole expression.
--------------------------------------------------------------- */
function currentToken(str) {
    let i = str.length;
    while (i > 0) {
        const c = str[i - 1];
        if (/[0-9.]/.test(c)) { i--; continue; }
        if (c === "e") { i--; continue; }
        if ((c === "+" || c === "-") && str[i - 2] === "e") { i--; continue; }
        break;
    }
    return str.slice(i);
}

// A value-ending display means an operator/postfix could legally follow it.
function endsWithValue(str) {
    if (str === "0" || isErrorMessage(str)) return false;
    return /[0-9)π!²³%]$/.test(str) || str.endsWith("⁻¹");
}

/* ---------------------------------------------------------------
   TOKENIZER
--------------------------------------------------------------- */
const FUNC_TOKENS = [
    ["sinh⁻¹(", "asinh"], ["cosh⁻¹(", "acosh"], ["tanh⁻¹(", "atanh"],
    ["sin⁻¹(", "asin"], ["cos⁻¹(", "acos"], ["tan⁻¹(", "atan"],
    ["sinh(", "sinh"], ["cosh(", "cosh"], ["tanh(", "tanh"],
    ["sin(", "sin"], ["cos(", "cos"], ["tan(", "tan"],
    ["log(", "log10"], ["ln(", "ln"],
    ["√(", "sqrt"], ["∛(", "cbrt"],
    ["eˣ(", "exp"], ["10ˣ(", "pow10"]
].sort((a, b) => b[0].length - a[0].length);

function tokenize(rawStr) {
    const str = rawStr.replace(/,/g, "");
    const tokens = [];
    let i = 0;

    while (i < str.length) {
        let matched = false;

        for (const [sym, name] of FUNC_TOKENS) {
            if (str.startsWith(sym, i)) {
                tokens.push({ type: "func", name });
                tokens.push({ type: "lparen" });
                i += sym.length;
                matched = true;
                break;
            }
        }
        if (matched) continue;

        if (str.startsWith("ʸ√", i)) { tokens.push({ type: "op", value: "yroot" }); i += 2; continue; }
        if (str.startsWith("⁻¹", i)) { tokens.push({ type: "postfix", value: "recip" }); i += 2; continue; }

        const ch = str[i];

        if (/\d/.test(ch)) {
            const m = /^\d+(\.\d+)?(e[+-]?\d*)?/.exec(str.slice(i));
            tokens.push({ type: "num", value: m[0] });
            i += m[0].length;
            continue;
        }
        if (ch === ".") {
            const m = /^\.\d+(e[+-]?\d*)?/.exec(str.slice(i));
            if (!m) throw new Error("Incomplete Expression");
            tokens.push({ type: "num", value: m[0] });
            i += m[0].length;
            continue;
        }
        if (ch === "π") { tokens.push({ type: "const" }); i++; continue; }
        if (ch === "(") { tokens.push({ type: "lparen" }); i++; continue; }
        if (ch === ")") { tokens.push({ type: "rparen" }); i++; continue; }
        if (ch === "+") { tokens.push({ type: "op", value: "+" }); i++; continue; }
        if (ch === "-") { tokens.push({ type: "op", value: "-" }); i++; continue; }
        if (ch === "x") { tokens.push({ type: "op", value: "x" }); i++; continue; }
        if (ch === "÷") { tokens.push({ type: "op", value: "÷" }); i++; continue; }
        if (ch === "^") { tokens.push({ type: "op", value: "^" }); i++; continue; }
        if (ch === "!") { tokens.push({ type: "postfix", value: "!" }); i++; continue; }
        if (ch === "²") { tokens.push({ type: "postfix", value: "²" }); i++; continue; }
        if (ch === "³") { tokens.push({ type: "postfix", value: "³" }); i++; continue; }
        if (ch === "%") { tokens.push({ type: "postfix", value: "%" }); i++; continue; }

        throw new Error("Math Error");
    }
    return tokens;
}

/* ---------------------------------------------------------------
   PARSER (recursive descent)
   precedence, low -> high:
   expression (+ -) > term (x ÷, incl. implicit multiply)
   > unary (-) > power (^ , ʸ√) > postfix (! ² ³ % ⁻¹) > atom
--------------------------------------------------------------- */
function parseNumberToken(str) {
    // parseFloat("5e+") happily returns 5, silently dropping the bad
    // exponent - so the format has to be validated explicitly here.
    if (!/^\d+(\.\d+)?(e[+-]?\d+)?$/.test(str)) throw new Error("Incomplete Expression");
    return parseFloat(str);
}

function parseTokens(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const consume = () => tokens[pos++];
    const expect = (type) => {
        if (!peek() || peek().type !== type) throw new Error("Incomplete Expression");
        return consume();
    };

    function startsFactor() {
        const t = peek();
        if (!t) return false;
        return t.type === "num" || t.type === "const" || t.type === "lparen" || t.type === "func";
    }

    function parseExpression() {
        let node = parseTerm();
        while (peek() && peek().type === "op" && (peek().value === "+" || peek().value === "-")) {
            const op = consume().value;
            const right = parseTerm();
            node = { op, left: node, right };
        }
        return node;
    }

    function parseTerm() {
        let node = parseUnary();
        while (true) {
            const t = peek();
            if (t && t.type === "op" && (t.value === "x" || t.value === "÷")) {
                const op = consume().value;
                const right = parseUnary();
                node = { op, left: node, right };
            } else if (startsFactor()) {
                const right = parseUnary();
                node = { op: "x", left: node, right };
            } else break;
        }
        return node;
    }

    function parseUnary() {
        if (peek() && peek().type === "op" && peek().value === "-") {
            consume();
            return { op: "neg", operand: parseUnary() };
        }
        if (peek() && peek().type === "op" && peek().value === "+") {
            consume();
            return parseUnary();
        }
        return parsePower();
    }

    function parsePower() {
        let node = parsePostfix();
        const t = peek();
        if (t && t.type === "op" && t.value === "^") {
            consume();
            const right = parseUnary();
            node = { op: "^", left: node, right };
        } else if (t && t.type === "op" && t.value === "yroot") {
            consume();
            const right = parseUnary();
            node = { op: "yroot", left: node, right };
        }
        return node;
    }

    function parsePostfix() {
        let node = parseAtom();
        while (peek() && peek().type === "postfix") {
            const op = consume().value;
            node = { op: "postfix:" + op, operand: node };
        }
        return node;
    }

    function parseAtom() {
        const t = peek();
        if (!t) throw new Error("Incomplete Expression");
        if (t.type === "num") { consume(); return { type: "num", value: parseNumberToken(t.value) }; }
        if (t.type === "const") { consume(); return { type: "num", value: Math.PI }; }
        if (t.type === "lparen") {
            consume();
            const node = parseExpression();
            expect("rparen");
            return node;
        }
        if (t.type === "func") {
            const name = consume().name;
            expect("lparen");
            const arg = parseExpression();
            expect("rparen");
            return { type: "func", name, arg };
        }
        throw new Error("Incomplete Expression");
    }

    const result = parseExpression();
    if (pos !== tokens.length) throw new Error("Math Error");
    return result;
}

/* ---------------------------------------------------------------
   EVALUATOR
--------------------------------------------------------------- */
function evaluateNode(node) {
    if (node.type === "num") return node.value;

    if (node.type === "func") {
        const arg = evaluateNode(node.arg);
        switch (node.name) {
            case "sin": return Math.sin(toRadiansIfNeeded(arg));
            case "cos": return Math.cos(toRadiansIfNeeded(arg));
            case "tan": {
                if (isDegree) {
                    const a = ((arg % 360) + 360) % 360;
                    if (a === 90 || a === 270) throw new Error("Undefined");
                }
                return Math.tan(toRadiansIfNeeded(arg));
            }
            case "asin":
                if (arg < -1 || arg > 1) throw new Error("Invalid Input");
                return toDegreesIfNeeded(Math.asin(arg));
            case "acos":
                if (arg < -1 || arg > 1) throw new Error("Invalid Input");
                return toDegreesIfNeeded(Math.acos(arg));
            case "atan": return toDegreesIfNeeded(Math.atan(arg));
            case "sinh": return Math.sinh(arg);
            case "cosh": return Math.cosh(arg);
            case "tanh": return Math.tanh(arg);
            case "asinh": return Math.asinh(arg);
            case "acosh":
                if (arg < 1) throw new Error("Invalid Input");
                return Math.acosh(arg);
            case "atanh":
                if (arg <= -1 || arg >= 1) throw new Error("Invalid Input");
                return Math.atanh(arg);
            case "log10":
                if (arg <= 0) throw new Error("Invalid Input");
                return Math.log10(arg);
            case "ln":
                if (arg <= 0) throw new Error("Invalid Input");
                return Math.log(arg);
            case "sqrt":
                if (arg < 0) throw new Error("Invalid Input");
                return Math.sqrt(arg);
            case "cbrt": return Math.cbrt(arg);
            case "exp": return Math.exp(arg);
            case "pow10": return Math.pow(10, arg);
        }
    }

    if (node.op === "neg") return -evaluateNode(node.operand);

    if (node.op && node.op.startsWith("postfix:")) {
        const v = evaluateNode(node.operand);
        switch (node.op) {
            case "postfix:!":
                if (!Number.isInteger(v)) throw new Error("Integers Only");
                if (v < 0) throw new Error("Invalid Input");
                if (v > 170) throw new Error("Math Error");
                { let f = 1; for (let n = 2; n <= v; n++) f *= n; return f; }
            case "postfix:²": return Math.pow(v, 2);
            case "postfix:³": return Math.pow(v, 3);
            case "postfix:%": return v / 100;
            case "postfix:recip":
                if (v === 0) throw new Error("Cannot divide by zero");
                return 1 / v;
        }
    }

    const l = evaluateNode(node.left);
    const r = evaluateNode(node.right);
    switch (node.op) {
        case "+": return l + r;
        case "-": return l - r;
        case "x": return l * r;
        case "÷":
            if (r === 0) throw new Error("Cannot divide by zero");
            return l / r;
        case "^": return Math.pow(l, r);
        case "yroot":
            if (l === 0) throw new Error("Cannot divide by zero");
            return Math.pow(r, 1 / l);
    }
}

function evaluateFullExpression(text) {
    const tokens = tokenize(text);
    if (tokens.length === 0) throw new Error("Incomplete Expression");
    const ast = parseTokens(tokens);
    const result = evaluateNode(ast);
    if (!Number.isFinite(result)) throw new Error("Math Error");
    return result;
}

/* ---------------------------------------------------------------
   RESULT FORMATTING (rounds off float noise, adds thousands
   separators, falls back to exponential for very big/small)
--------------------------------------------------------------- */
function formatResult(num) {
    const rounded = Number(num.toPrecision(12));
    if (rounded === 0) return "0";
    const abs = Math.abs(rounded);

    if (abs >= 1e15 || abs < 1e-6) {
        let exp = rounded.toExponential(6);
        exp = exp.replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
        return exp;
    }

    const str = rounded.toString();
    let [intPart, decPart] = str.split(".");
    let sign = "";
    if (intPart.startsWith("-")) { sign = "-"; intPart = intPart.slice(1); }
    intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return sign + intPart + (decPart ? "." + decPart : "");
}

/* ---------------------------------------------------------------
   INPUT HELPERS - these are the guards that stop invalid
   characters from ever being typed (2nd defense is the parser
   itself, which will throw on anything that slips through)
--------------------------------------------------------------- */
function insertOperator(symbol) {
    let current = display.innerText;
    if (current === "0" || isErrorMessage(current)) {
        if (symbol === "-") display.innerText = "-";
        scrollDisplayToEnd();
        return;
    }
    if (symbol === "-") {
        if (current.endsWith("-")) return;
        display.innerText = current + "-";
    } else {
        if (!endsWithValue(current)) return;
        display.innerText = current + symbol;
    }
    scrollDisplayToEnd();
}

function insertPostfix(symbol) {
    const current = display.innerText;
    if (!endsWithValue(current)) return;
    display.innerText = current + symbol;
    scrollDisplayToEnd();
}

function insertFunction(token) {

    let current = display.innerText;

    if (current === "0" || isErrorMessage(current)) {
        current = "";
    }

    // Automatically insert multiplication when a value
    // is followed by a function.
    if (endsWithValue(current)) {
        current += "x";
    }

    display.innerText = current + token;

    openParens++;

    scrollDisplayToEnd();
}

function insertRaw(token) {
    let current = display.innerText;
    if (current === "0" || isErrorMessage(current)) current = "";
    display.innerText = current + token;
    scrollDisplayToEnd();
}

buttons.forEach(button => {
    button.addEventListener("click", () => {
        const key = button.dataset.key;
        const current = display.innerText;
        try {
            handleKey(key, current, button);
        } catch (err) {
            showError(err.message || "Math Error");
        }
    });
});

// --- Pressed effect (shrink + darken) ---
buttons.forEach(button => {
    const press = () => button.classList.add("pressed");
    const release = () => button.classList.remove("pressed");

    button.addEventListener("mousedown", press);
    button.addEventListener("touchstart", press, { passive: true });

    ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach(evt =>
        button.addEventListener(evt, release)
    );
});

function handleKey(key, current, button) {

    // Any left-over comma formatting from a previous result gets
    // stripped the moment the user keeps typing.
    if (display.innerText.includes(",")) {
        display.innerText = display.innerText.replace(/,/g, "");
        current = display.innerText;
    }

    if (key === "theme-toggle") {
        isLight = !isLight;
        htmlEl.setAttribute("data-theme", isLight ? "light" : "dark");
        button.textContent = isLight ? "☀" : "🌙";
        return;
    }

    if (key === "history") { openHistory(); return; }
    if (key === "history-close") { closeHistory(); return; }
    if (key === "history-clear") { history = []; openHistory(); return; }

    if (key === "ac") {
        display.innerText = "0";
        openParens = 0;
        secondMode = false;

        getButtonByKey("sin").innerText = "sin";
        getButtonByKey("cos").innerText = "cos";
        getButtonByKey("tan").innerText = "tan";
        getButtonByKey("sinh").innerText = "sinh";
        getButtonByKey("cosh").innerText = "cosh";
        getButtonByKey("tanh").innerText = "tanh";
        getButtonByKey("square").innerText = "x²";
        getButtonByKey("cube").innerText = "x³";
        getButtonByKey("log").innerText = "log";
        getButtonByKey("ln").innerText = "ln";
        return;
    }

    if (key === "back") {
        if (current.length <= 1 || isErrorMessage(current)) {
            display.innerText = "0";
            openParens = 0;
            scrollDisplayToEnd();
            return;
        }
        const last = current.slice(-1);
        if (last === "(") openParens = Math.max(0, openParens - 1);
        if (last === ")") openParens++;

        display.innerText = current.slice(0, -1);
        if (display.innerText === "") display.innerText = "0";
        scrollDisplayToEnd();
        return;
    }

    if (key === "second") {
        secondMode = !secondMode;
        getButtonByKey("sin").innerText = secondMode ? "sin⁻¹" : "sin";
        getButtonByKey("cos").innerText = secondMode ? "cos⁻¹" : "cos";
        getButtonByKey("tan").innerText = secondMode ? "tan⁻¹" : "tan";
        getButtonByKey("sinh").innerText = secondMode ? "sinh⁻¹" : "sinh";
        getButtonByKey("cosh").innerText = secondMode ? "cosh⁻¹" : "cosh";
        getButtonByKey("tanh").innerText = secondMode ? "tanh⁻¹" : "tanh";
        getButtonByKey("square").innerText = secondMode ? "√" : "x²";
        getButtonByKey("cube").innerText = secondMode ? "∛" : "x³";
        getButtonByKey("log").innerText = secondMode ? "10ˣ" : "log";
        getButtonByKey("ln").innerText = secondMode ? "eˣ" : "ln";
        return;
    }

    if (key === "recip") { insertPostfix("⁻¹"); return; }
    if (key === "fact") { insertPostfix("!"); return; }
    if (key === "percent") { insertPostfix("%"); return; }

    if (key === "square") {
        if (secondMode) insertFunction("√("); else insertPostfix("²");
        return;
    }
    if (key === "cube") {
        if (secondMode) insertFunction("∛("); else insertPostfix("³");
        return;
    }
    if (key === "sqrt") { insertFunction("√("); return; }

    if (key === "ln") {
        insertFunction(secondMode ? "eˣ(" : "ln(");
        return;
    }
    if (key === "log") {
        insertFunction(secondMode ? "10ˣ(" : "log(");
        return;
    }
    if (key === "exp") { insertFunction("eˣ("); return; }
    if (key === "pow10") { insertFunction("10ˣ("); return; }

    if (key === "sin") { insertFunction(secondMode ? "sin⁻¹(" : "sin("); return; }
    if (key === "cos") { insertFunction(secondMode ? "cos⁻¹(" : "cos("); return; }
    if (key === "tan") { insertFunction(secondMode ? "tan⁻¹(" : "tan("); return; }
    if (key === "sinh") { insertFunction(secondMode ? "sinh⁻¹(" : "sinh("); return; }
    if (key === "cosh") { insertFunction(secondMode ? "cosh⁻¹(" : "cosh("); return; }
    if (key === "tanh") { insertFunction(secondMode ? "tanh⁻¹(" : "tanh("); return; }

    if (key === "pi") { insertRaw("π"); return; }
    if (key === "pow") { insertOperator("^"); return; }
    if (key === "yroot") { insertOperator("ʸ√"); return; }

    if (key === "deg") {
        isDegree = !isDegree;
        button.innerText = isDegree ? "Deg" : "Rad";
        return;
    }

    if (key === "negate") {
        const m = /\d+(\.\d+)?(e[+-]?\d*)?$/.exec(current);
        if (!m) return;
        const before = current.slice(0, m.index);
        if (before.endsWith("-")) {
            const beforeMinus = before.slice(0, -1);
            const lastCh = beforeMinus.slice(-1);
            const isUnary = beforeMinus === "" || /[+\-x÷^(]/.test(lastCh) || beforeMinus.endsWith("ʸ√");
            display.innerText = isUnary ? beforeMinus + m[0] : before + "-" + m[0];
        } else {
            display.innerText = before + "-" + m[0];
        }
        scrollDisplayToEnd();
        return;
    }

    if (key === "rand") {
        let cur = current;
        if (cur === "0" || isErrorMessage(cur)) cur = "";
        display.innerText = cur + Number(Math.random().toPrecision(10));
        scrollDisplayToEnd();
        return;
    }

    if (key === "ee") {
        if (current === "0" || isErrorMessage(current)) return;
        if (!/\d$/.test(current)) return;
        if (currentToken(current).includes("e")) return;
        display.innerText = current + "e";
        scrollDisplayToEnd();
        return;
    }

    if (key === "m-plus") { memory += evaluateFullExpression(display.innerText); return; }
    if (key === "m-minus") { memory -= evaluateFullExpression(display.innerText); return; }
    if (key === "mr") { display.innerText = formatResult(memory); scrollDisplayToEnd(); return; }
    if (key === "mc") { memory = 0; return; }

    if (key === "equals") {
        const expr = display.innerText;
        const answer = evaluateFullExpression(expr);
        const formatted = formatResult(answer);
        history.unshift(expr + " = " + formatted);
        if (history.length > 100) history.pop();
        display.innerText = formatted;
        openParens = 0;
        scrollDisplayToEnd();
        return;
    }

    if (key === "decimal") {
        if (current === "0" || isErrorMessage(current)) {
            display.innerText = "0.";
            scrollDisplayToEnd();
            return;
        }
        const token = currentToken(current);
        if (token.includes(".") || token.includes("e")) return;
        display.innerText = /\d$/.test(current) ? current + "." : current + "0.";
        scrollDisplayToEnd();
        return;
    }

    if (["add", "sub", "mul", "div"].includes(key)) {
        const symbol = { add: "+", sub: "-", mul: "x", div: "÷" }[key];
        insertOperator(symbol);
        return;
    }

    if (key === "paren-open") { insertFunction("("); return; }
    if (key === "paren-close") {
        if (openParens === 0 || current.endsWith("(")) return;
        display.innerText = current + ")";
        openParens--;
        scrollDisplayToEnd();
        return;
    }

    // Digits
    let cur = current;
    if (cur === "0" || isErrorMessage(cur)) cur = "";
    display.innerText = cur + key;
    scrollDisplayToEnd();
}

/* ---------------------------------------------------------------
   HISTORY POPUP
--------------------------------------------------------------- */
const historyOverlay = document.getElementById("history-overlay");
const historyList = document.getElementById("history-list");

function openHistory() {
    historyList.innerHTML = "";
    if (history.length === 0) {
        const li = document.createElement("li");
        li.textContent = "No calculations yet.";
        historyList.appendChild(li);
    } else {
        history.forEach(entry => {
            const li = document.createElement("li");
            li.textContent = entry;
            historyList.appendChild(li);
        });
    }
    historyOverlay.classList.remove("hidden");
}

function closeHistory() {
    historyOverlay.classList.add("hidden");
}

historyOverlay.addEventListener("click", event => {
    if (event.target === historyOverlay) closeHistory();
});

/* ---------------------------------------------------------------
   KEYBOARD INPUT
--------------------------------------------------------------- */
const KEY_MAP = {
    "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
    "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
    ".": "decimal", "+": "add", "-": "sub", "*": "mul", "/": "div",
    "^": "pow", "(": "paren-open", ")": "paren-close", "%": "percent",
    "Enter": "equals", "=": "equals", "Backspace": "back", "Escape": "ac",
    "Delete": "ac", "p": "pi"
};

document.addEventListener("keydown", (e) => {
    const key = KEY_MAP[e.key];
    if (!key) return;
    if (!historyOverlay.classList.contains("hidden")) return;
    e.preventDefault();
    const btn = getButtonByKey(key);
    if (!btn) return;
    btn.classList.add("pressed");
    setTimeout(() => btn.classList.remove("pressed"), 100);
    btn.click();
});