const lib = require("./lib");
const loop_rewriter = require("./loop_rewriter");
const escodegen = require("escodegen");
const acorn = require("acorn");
const fs = require("fs");
const iconv = require("iconv-lite");
const path = require("path");
const {VM} = require("vm2");
const child_process = require("child_process");
const argv = require("./argv.js").run;
const jsdom = require("jsdom").JSDOM;
const dom = new jsdom(`<html><head></head><body></body></html>`);

const filename = process.argv[2];

// JScriptMemberFunctionStatement plugin registration
require("./patches/prototype-plugin.js")(acorn);

lib.debug("Analysis launched: " + JSON.stringify(process.argv));
lib.verbose("Box-js version: " + require("./package.json").version);

let git_path = path.join(__dirname, ".git");
if (fs.existsSync(git_path) && fs.lstatSync(git_path).isDirectory()) {
    lib.verbose("Commit: " + fs.readFileSync(path.join(__dirname, ".git/refs/heads/master"), "utf8").replace(/\n/, ""));
} else {
    lib.verbose("No git folder found.");
}
lib.verbose(`Analyzing ${filename}`, false);
const sampleBuffer = fs.readFileSync(filename);
let encoding;
if (argv.encoding) {
    lib.debug("Using argv encoding");
    encoding = argv.encoding;
} else {
    lib.debug("Using detected encoding");
    encoding = require("jschardet").detect(sampleBuffer).encoding;
    if (encoding === null) {
        lib.warning("jschardet (v" + require("jschardet/package.json").version + ") couldn't detect encoding, using UTF-8");
        encoding = "utf8";
    } else {
        lib.debug("jschardet (v" + require("jschardet/package.json").version + ") detected encoding " + encoding);
    }
}

let code = iconv.decode(sampleBuffer, encoding);

if (code.match("<job") || code.match("<script")) { // The sample may actually be a .wsf, which is <job><script>..</script><script>..</script></job>.
    lib.debug("Sample seems to be WSF");
    code = code.replace(/<\??\/?\w+( [\w=\"\']*)*\??>/g, ""); // XML tags
    code = code.replace(/<!\[CDATA\[/g, "");
    code = code.replace(/\]\]>/g, "");
}

function lacksBinary(name) {
    const path = child_process.spawnSync("command", ["-v", name], {
        shell: true
    }).stdout;
    return path.length === 0;
}

function rewrite(code) {

    // box-js is assuming that the JS will be run on Windows with cscript or wscript.
    // Neither of these engines supports strict JS mode, so remove those calls from
    // the code.
    code = code.toString().replace(/("|')use strict("|')/g, '"STRICT MODE NOT SUPPORTED"');

    // Some samples (for example that use JQuery libraries as a basis to which to
    // add malicious code) won't emulate properly for some reason if there is not
    // an assignment line at the start of the code. Add one here (this should not
    // change the behavior of the code).
    code = "__bogus_var_name__ = 12;\n\n" + code;
    
    if (code.match("@cc_on")) {
        lib.debug("Code uses conditional compilation");
        if (!argv["no-cc_on-rewrite"]) {
            code = code
                .replace(/\/\*@cc_on/gi, "")
                .replace(/@cc_on/gi, "")
                .replace(/\/\*@/g, "\n").replace(/@\*\//g, "\n");
            // "@if" processing requires m4 and cc, but don't require them otherwise
            if (/@if/.test(code)) {
                /*
                	"@if (cond) source" becomes "\n _boxjs_if(cond)" with JS
                	"\n _boxjs_if(cond)" becomes "\n #if (cond) \n source" with m4
                	"\n #if (cond) \n source" becomes "source" with the C preprocessor
                */
                code = code
                    .replace(/@if\s*/gi, "\n_boxjs_if")
                    .replace(/@elif\s*/gi, "\n_boxjs_elif")
                    .replace(/@else/gi, "\n#else\n")
                    .replace(/@end/gi, "\n#endif\n")
                    .replace(/@/g, "_boxjs_at");
                // Require m4, cc
                if (lacksBinary("cc")) lib.kill("You must install a C compiler (executable 'cc' not found).");
                if (lacksBinary("m4")) lib.kill("You must install m4.");
                code = `
define(\`_boxjs_if', #if ($1)\n)
define(\`_boxjs_elif', #elif ($1)\n)
` + code;
                lib.info("    Replacing @cc_on statements (use --no-cc_on-rewrite to skip)...", false);
                const outputM4 = child_process.spawnSync("m4", [], {
                    input: code
                });
                const outputCc = child_process.spawnSync("cc", [
                    "-E", "-P", // preprocess, don't compile
                    "-xc", // read from stdin, lang: c
                    "-D_boxjs_at_x86=1", "-D_boxjs_at_win16=0", "-D_boxjs_at_win32=1", "-D_boxjs_at_win64=1", // emulate Windows 32 bit
                    "-D_boxjs_at_jscript=1",
                    "-o-", // print to stdout
                    "-", // read from stdin
                ], {
                    input: outputM4.stdout.toString("utf8"),
                });
                code = outputCc.stdout.toString("utf8");
            }
            code = code.replace(/_boxjs_at/g, "@");
        } else {
            lib.warn(
                `The code appears to contain conditional compilation statements.
If you run into unexpected results, try uncommenting lines that look like

    /*@cc_on
    <JavaScript code>
    @*/

`
            );
        }
    }

    if (!argv["no-rewrite"]) {
        try {
            lib.verbose("Rewriting code...", false);
            if (argv["dumb-concat-simplify"]) {
                lib.verbose("    Simplifying \"dumb\" concatenations (remove --dumb-concat-simplify to skip)...", false);
                code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
                code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
            }

            let tree;
            try {
                tree = acorn.parse(code, {
                    allowReturnOutsideFunction: true, // used when rewriting function bodies
                    plugins: {
                        // enables acorn plugin needed by prototype rewrite
                        JScriptMemberFunctionStatement: !argv["no-rewrite-prototype"],
                    },
                });
            } catch (e) {
                lib.error("Couldn't parse with Acorn:");
                lib.error(e);
                lib.error("");
                if (filename.match(/jse$/)) {
                    lib.error(
                        `This appears to be a JSE (JScript.Encode) file.
Please compile the decoder and decode it first:

cc decoder.c -o decoder
./decoder ${filename} ${filename.replace(/jse$/, "js")}

`
                    );
                } else {
                    lib.error(
                        // @@@ Emacs JS mode does not properly parse this block.
                        //`This doesn't seem to be a JavaScript/WScript file.
                        //If this is a JSE file (JScript.Encode), compile
                        //decoder.c and run it on the file, like this:
                        //
                        //cc decoder.c -o decoder
                        //./decoder ${filename} ${filename}.js
                        //
                        //`
                        "Decode JSE. 'cc decoder.c -o decoder'. './decoder ${filename} ${filename}.js'"
                    );
                }
                process.exit(4);
                return;
            }

            // Loop rewriting is looking for loops in the original unmodified code so
            // do this before any other modifications.
            if (argv["rewrite-loops"]) {
                lib.verbose("    Rewriting loops...", false);
                traverse(tree, loop_rewriter.rewriteSimpleWaitLoop);
                traverse(tree, loop_rewriter.rewriteSimpleControlLoop);
            };

            if (argv["throttle-writes"]) {
                lib.throttleFileWrites(true);
            };
            
            if (argv.preprocess) {
                lib.verbose(`    Preprocessing with uglify-es v${require("uglify-es/package.json").version} (remove --preprocess to skip)...`, false);
                const unsafe = !!argv["unsafe-preprocess"];
                lib.debug("Unsafe preprocess: " + unsafe);
                const result = require("uglify-es").minify(code, {
                    parse: {
                        bare_returns: true, // used when rewriting function bodies
                    },
                    compress: {
                        passes: 3,

                        booleans: true,
                        collapse_vars: true,
                        comparisons: true,
                        conditionals: true,
                        dead_code: true,
                        drop_console: false,
                        evaluate: true,
                        if_return: true,
                        inline: true,
                        join_vars: false, // readability
                        keep_fargs: unsafe, // code may rely on Function.length
                        keep_fnames: unsafe, // code may rely on Function.prototype.name
                        keep_infinity: true, // readability
                        loops: true,
                        negate_iife: false, // readability
                        properties: true,
                        pure_getters: false, // many variables are proxies, which don't have pure getters
                        /* If unsafe preprocessing is enabled, tell uglify-es that Math.* functions
                         * have no side effects, and therefore can be removed if the result is
                         * unused. Related issue: mishoo/UglifyJS2#2227
                         */
                        pure_funcs: unsafe ?
                            // https://stackoverflow.com/a/10756976
                            Object.getOwnPropertyNames(Math).map(key => `Math.${key}`) : null,
                        reduce_vars: true,
                        /* Using sequences (a; b; c; -> a, b, c) provides some performance benefits
                         * (https://github.com/CapacitorSet/box-js/commit/5031ba7114b60f1046e53b542c0e4810aad68a76#commitcomment-23243778),
                         * but it makes code harder to read. Therefore, this behaviour is disabled.
                         */
                        sequences: false,
                        toplevel: true,
                        typeofs: false, // typeof foo == "undefined" -> foo === void 0: the former is more readable
                        unsafe,
                        unused: true,
                    },
                    output: {
                        beautify: true,
                        comments: true,
                    },
                });
                if (result.error) {
                    lib.error("Couldn't preprocess with uglify-es: " + JSON.stringify(result.error));
                } else {
                    code = result.code;
                }
            }
            
            if (!argv["no-rewrite-prototype"]) {
                lib.verbose("    Replacing `function A.prototype.B()` (use --no-rewrite-prototype to skip)...", false);
                traverse(tree, function(key, val) {
                    if (!val) return;
                    //console.log("----");
                    //console.log(JSON.stringify(val, null, 2));
                    if (val.type !== "FunctionDeclaration" &&
                        val.type !== "FunctionExpression") return;
                    if (!val.id) return;
                    if (val.id.type !== "MemberExpression") return;
                    r = require("./patches/prototype.js")(val);
                    return r;
                });
            }

            if (!argv["no-hoist-prototype"]) {
                lib.verbose("    Hoisting `function A.prototype.B()` (use --no-hoist-prototype to skip)...", false);
                hoist(tree);
            }

            if (argv["function-rewrite"]) {
                lib.verbose("    Rewriting functions (remove --function-rewrite to skip)...", false);
                traverse(tree, function(key, val) {
                    if (key !== "callee") return;
                    if (val.autogenerated) return;
                    switch (val.type) {
                        case "MemberExpression":
                            return require("./patches/this.js")(val.object, val);
                        default:
                            return require("./patches/nothis.js")(val);
                    }
                });
            }

            if (!argv["no-typeof-rewrite"]) {
                lib.verbose("    Rewriting typeof calls (use --no-typeof-rewrite to skip)...", false);
                traverse(tree, function(key, val) {
                    if (!val) return;
                    if (val.type !== "UnaryExpression") return;
                    if (val.operator !== "typeof") return;
                    if (val.autogenerated) return;
                    return require("./patches/typeof.js")(val.argument);
                });
            }

            if (!argv["no-eval-rewrite"]) {
                lib.verbose("    Rewriting eval calls (use --no-eval-rewrite to skip)...", false);
                traverse(tree, function(key, val) {
                    if (!val) return;
                    if (val.type !== "CallExpression") return;
                    if (val.callee.type !== "Identifier") return;
                    if (val.callee.name !== "eval") return;
                    return require("./patches/eval.js")(val.arguments);
                });
            }

            if (!argv["no-catch-rewrite"]) { // JScript quirk
                lib.verbose("    Rewriting try/catch statements (use --no-catch-rewrite to skip)...", false);
                traverse(tree, function(key, val) {
                    if (!val) return;
                    if (val.type !== "TryStatement") return;
                    if (!val.handler) return;
                    if (val.autogenerated) return;
                    return require("./patches/catch.js")(val);
                });
            }

            code = escodegen.generate(tree);
            //console.log("!!!! CODE !!!!");
            //console.log(code);

            // The modifications may have resulted in more concatenations, eg. "a" + ("foo", "b") + "c" -> "a" + "b" + "c"
            if (argv["dumb-concat-simplify"]) {
                lib.verbose("    Simplifying \"dumb\" concatenations (remove --dumb-concat-simplify to skip)...", false);
                code = code.replace(/'[ \r\n]*\+[ \r\n]*'/gm, "");
                code = code.replace(/"[ \r\n]*\+[ \r\n]*"/gm, "");
            }

            lib.verbose("Rewritten successfully.", false);
        } catch (e) {
            console.log("An error occurred during rewriting:");
            console.log(e);
            process.exit(3);
        }
    }

    return code;
}

code = rewrite(code);

// prepend extra JS containing mock objects in the given file(s) onto the code
if (argv["prepended-code"]) {

    var prependedCode = ""
    var files = []

    // get all the files in the directory and sort them alphebetically
    if (fs.lstatSync(argv["prepended-code"]).isDirectory()) {

        dir_files = fs.readdirSync(argv["prepended-code"]);
        for (var i = 0; i < dir_files.length; i++) {
            files.push(path.join(argv["prepended-code"], dir_files[i]))
        }

        // make sure we're adding mock code in the right order
        files.sort()
    } else {
        files.push(argv["prepended-code"])
    }

    for (var i = 0; i < files.length; i++) {
        prependedCode += fs.readFileSync(files[i], 'utf-8') + "\n\n"
    }

    code = prependedCode + "\n\n" + code
}

// prepend patch code, unless it is already there.
if (!code.includes("let __PATCH_CODE_ADDED__ = true;")) {
    code = fs.readFileSync(path.join(__dirname, "patch.js"), "utf8") + code;
}
else {
    console.log("Patch code already added.");
}

// append more code
code += "\n\n" + fs.readFileSync(path.join(__dirname, "appended-code.js"));

lib.logJS(code);

Array.prototype.Count = function() {
    return this.length;
};

// Set the fake scripting engine to report.
var fakeEngineShort = "wscript.exe"
if (argv["fake-script-engine"]) {
    fakeEngineShort = argv["fake-script-engine"];
}
var fakeEngineFull = "C:\\WINDOWS\\system32\\" + fakeEngineShort;

var wscript_proxy = new Proxy({
    arguments: new Proxy((n) => `${n}th argument`, {
        get: function(target, name) {
            switch (name) {
            case "Unnamed":
                return [];
            case "length":
                return 0;
            case "ShowUsage":
                return {
                    typeof: "unknown",
                };
            case "Named":
                return [];
            default:
                return new Proxy(
                    target[name], {
                        get: (target, name) => name.toLowerCase() === "typeof" ? "unknown" : target[name],
                    }
                );
            }
        },
    }),
    buildversion: "1234",
    interactive: true,
    fullname: fakeEngineFull,
    name: fakeEngineShort,
    path: "C:\\TestFolder\\",
    //scriptfullname: "C:\\Documents and Settings\\User\\Desktop\\sample.js",
    //scriptfullname: "C:\\Users\\Sysop12\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\ons.jse",
    scriptfullname: "C:\Users\\Sysop12\\AppData\\Roaming\\Microsoft\\Templates\\CURRENT_SCRIPT_IN_FAKED_DIR.js",
    scriptname: "CURRENT_SCRIPT_IN_FAKED_DIR.js",
    quit: function() {
        lib.info("The sample called WScript.Quit(). Exiting.");
        process.exit(0);
    },
    get stderr() {
        lib.error("WScript.StdErr not implemented");
    },
    get stdin() {
        lib.error("WScript.StdIn not implemented");
    },
    get stdout() {
        lib.error("WScript.StdOut not implemented");
    },
    version: "5.8",
    get connectobject() {
        lib.error("WScript.ConnectObject not implemented");
    },
    createobject: ActiveXObject,
    get disconnectobject() {
        lib.error("WScript.DisconnectObject not implemented");
    },
    echo() {},
    get getobject() {
        lib.error("WScript.GetObject not implemented");
    },
    // Note that Sleep() is implemented in patch.js because it requires
    // access to the variable _globalTimeOffset, which belongs to the script
    // and not to the emulator.
    [Symbol.toPrimitive]: () => "Windows Script Host",
    tostring: "Windows Script Host",
}, {
    get(target, prop) {
        // For whatever reasons, WScript.* properties are case insensitive.
        if (typeof prop === "string")
            prop = prop.toLowerCase();
        return target[prop];
    }
});

const sandbox = {
    saveAs : function(data, fname) {
        // TODO: If Blob need to extract the data.
        lib.writeFile(fname, data);
    },
    setInterval : function() {},
    setTimeout : function(func, time) {

        // The interval should be an int, so do a basic check for int.
        if ((typeof(time) !== "number") || (time == null)) {
            throw("time is not a number.");
        }
        
        // Just call the function immediately, no waiting.
        if (typeof(func) === "function") {
            func();
        }
        else {
            throw("Callback must be a function");
        }
    },
    logJS: lib.logJS,
    logIOC: lib.logIOC,
    logUrl: lib.logUrl,
    ActiveXObject,
    dom,
    alert: (x) => {},
    InstallProduct: (x) => {
        lib.logUrl("InstallProduct", x);
    },
    console: {
        //log: (x) => console.log(x),
        //log: (x) => lib.info("Script output: " + JSON.stringify(x)),
        log: (x) => lib.info("Script output: " + x),
    },
    Enumerator: require("./emulator/Enumerator"),
    GetObject: require("./emulator/WMI").GetObject,
    JSON,
    location: new Proxy({
        href: "http://www.foobar.com/",
        protocol: "http:",
        host: "www.foobar.com",
        hostname: "www.foobar.com",
    }, {
        get: function(target, name) {
            switch (name) {
                case Symbol.toPrimitive:
                    return () => "http://www.foobar.com/";
                default:
                    return target[name.toLowerCase()];
            }
        },
    }),
    parse: (x) => {},
    rewrite: (code, log = false) => {
        const ret = rewrite(code);
        if (log) lib.logJS(ret);
        return ret;
    },
    ScriptEngine: () => {
        const type = "JScript"; // or "JavaScript", or "VBScript"
        // lib.warn(`Emulating a ${type} engine (in ScriptEngine)`);
        return type;
    },
    _typeof: (x) => x.typeof ? x.typeof : typeof x,
    WScript: wscript_proxy,
    WSH: wscript_proxy,
    self: {},
    require
};

// See https://github.com/nodejs/node/issues/8071#issuecomment-240259088
// It will prevent console.log from calling the "inspect" property,
// which can be kinda messy with Proxies
require("util").inspect.defaultOptions.customInspect = false;

if (argv["dangerous-vm"]) {
    lib.verbose("Analyzing with native vm module (dangerous!)");
    const vm = require("vm");
    //console.log(code);
    vm.runInNewContext(code, sandbox, {
        displayErrors: true,
        // lineOffset: -fs.readFileSync(path.join(__dirname, "patch.js"), "utf8").split("\n").length,
        filename: "sample.js",
    });
} else {
    lib.debug("Analyzing with vm2 v" + require("vm2/package.json").version);

    const vm = new VM({
        timeout: (argv.timeout || 10) * 1000,
        sandbox,
    });

    // Fake cscript.exe style ReferenceError messages.
    code = "ReferenceError.prototype.toString = function() { return \"[object Error]\";};\n\n" + code;
    // Fake up Object.toString not being defined in cscript.exe.
    //code = "Object.prototype.toString = undefined;\n\n" + code;

    try{
        vm.run(code);
    } catch (e) {
        lib.error("Sandbox execution failed:");
        console.log(e.stack);
        lib.error(e.message);
        process.exit(1);
    }
}

function ActiveXObject(name) {
    lib.verbose(`New ActiveXObject: ${name}`);
    name = name.toLowerCase();
    if (name.match("xmlhttp") || name.match("winhttprequest"))
        return require("./emulator/XMLHTTP");
    if (name.match("dom")) {
        return {
            createElement: require("./emulator/DOM"),
            load: (filename) => {
                // console.log(`Loading ${filename} in a virtual DOM environment...`);
            },
        };
    }

    switch (name) {
    case "windowsinstaller.installer":
        return require("./emulator/WindowsInstaller");
    case "adodb.stream":
        return require("./emulator/ADODBStream")();
    case "adodb.recordset":
        return require("./emulator/ADODBRecordSet")();
    case "adodb.connection":
        return require("./emulator/ADODBConnection")();
    case "scriptcontrol":
        return require("./emulator/ScriptControl");
    case "scripting.filesystemobject":
        return require("./emulator/FileSystemObject");
    case "scripting.dictionary":
        return require("./emulator/Dictionary");
    case "shell.application":
        return require("./emulator/ShellApplication");
    case "internetexplorer.application":
        return require("./emulator/InternetExplorerApplication");
    case "wscript.network":
        return require("./emulator/WScriptNetwork");
    case "wscript.shell":
        return require("./emulator/WScriptShell");
    case "wbemscripting.swbemlocator":
        return require("./emulator/WBEMScriptingSWBEMLocator");
    case "msscriptcontrol.scriptcontrol":
        return require("./emulator/MSScriptControlScriptControl");
    case "schedule.service":
        return require("./emulator/ScheduleService");
    default:
        lib.kill(`Unknown ActiveXObject ${name}`);
        break;
    }
}

function traverse(obj, func) {
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const replacement = func.apply(this, [key, obj[key]]);
        if (replacement) obj[key] = replacement;
        if (obj.autogenerated) continue;
        if (obj[key] !== null && typeof obj[key] === "object")
            traverse(obj[key], func);
    }
}

// Emulation of member function statements hoisting of by doing some reordering within AST
function hoist(obj, scope) {
    scope = scope || obj;
    // All declarations should be moved to the top of current function scope
    let newScope = scope;
    if (obj.type === "FunctionExpression" && obj.body.type === "BlockStatement")
        newScope = obj.body;

    for (const key of Object.keys(obj)) {
        if (obj[key] !== null && typeof obj[key] === "object") {
            const hoisted = [];
            if (Array.isArray(obj[key])) {
                obj[key] = obj[key].reduce((arr, el) => {
                    if (el && el.hoist) {
                        // Mark as hoisted yet
                        el.hoist = false;
                        // Should be hoisted? Add to array and filter out from current.
                        hoisted.push(el);
                        // If it was an expression: leave identifier
                        if (el.hoistExpression)
                            arr.push(el.expression.left);
                    } else
                        arr.push(el);
                    return arr;
                }, []);
            } else if (obj[key].hoist) {
                const el = obj[key];

                el.hoist = false;
                hoisted.push(el);
                obj[key] = el.expression.left;
            }
            scope.body.unshift(...hoisted);
            // Hoist all elements
            hoist(obj[key], newScope);
        }
    }
}
