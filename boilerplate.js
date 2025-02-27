const parse = require("node-html-parser").parse;
const lib = require("./lib.js");

// Handle Blobs. All Blob methods in the real Blob class for dumping
// the data in a Blob are asynch and box-js is all synchronous, so
// rather than rewriting the entire tool to be asynch we are just
// stubbing out a simple Blob class that is synchronous.
class Blob {
    constructor(data, type) {
        this.raw_data = data;
        // Convert to a data string if this is an array of bytes.
        this.data = "";
        var flat = [];
        for (let i = 0; i < data.length; i++) {
            if ((Array.isArray(data[i])) || (data[i].constructor.name == "Uint8Array")) {
                for (let j = 0; j < data[i].length; j++) {
                    flat.push(data[i][j]);
                }
            }
        }
        if (!flat.some(i => (!Number.isInteger(i) || (i < 0) || (i > 255)))) {
            for (let i = 0; i < flat.length; i++) {
                this.data += String.fromCharCode(flat[i]);
            };
        }
    };
};
Object.prototype.Blob = Blob;

// Simple Enumerator class implementation.
class Enumerator {
    constructor(collection) {
        if (typeof(collection.length) == "undefined") throw "Enumerator collection has no .length attr";
        this.collection = collection;
        this.currIndex = 0;
    };

    atEnd() {
        return (this.currIndex >= this.collection.length);
    };

    moveNext() {
        this.currIndex++;
    };

    item() {
        if (this.atEnd()) throw "Over end of all Enumerator data";
        return this.collection[this.currIndex];
    };
};

// atob() taken from abab.atob.js .

/**
 * Implementation of atob() according to the HTML and Infra specs, except that
 * instead of throwing INVALID_CHARACTER_ERR we return null.
 */
function atob(data) {
  // Web IDL requires DOMStrings to just be converted using ECMAScript
  // ToString, which in our case amounts to using a template literal.
  data = `${data}`;
  // "Remove all ASCII whitespace from data."
  data = data.replace(/[ \t\n\f\r]/g, "");
  // "If data's length divides by 4 leaving no remainder, then: if data ends
  // with one or two U+003D (=) code points, then remove them from data."
  if (data.length % 4 === 0) {
    data = data.replace(/==?$/, "");
  }
  // "If data's length divides by 4 leaving a remainder of 1, then return
  // failure."
  //
  // "If data contains a code point that is not one of
  //
  // U+002B (+)
  // U+002F (/)
  // ASCII alphanumeric
  //
  // then return failure."
  if (data.length % 4 === 1 || /[^+/0-9A-Za-z]/.test(data)) {
    return null;
  }
  // "Let output be an empty byte sequence."
  let output = "";
  // "Let buffer be an empty buffer that can have bits appended to it."
  //
  // We append bits via left-shift and or.  accumulatedBits is used to track
  // when we've gotten to 24 bits.
  let buffer = 0;
  let accumulatedBits = 0;
  // "Let position be a position variable for data, initially pointing at the
  // start of data."
  //
  // "While position does not point past the end of data:"
  for (let i = 0; i < data.length; i++) {
    // "Find the code point pointed to by position in the second column of
    // Table 1: The Base 64 Alphabet of RFC 4648. Let n be the number given in
    // the first cell of the same row.
    //
    // "Append to buffer the six bits corresponding to n, most significant bit
    // first."
    //
    // atobLookup() implements the table from RFC 4648.
    buffer <<= 6;
    buffer |= atobLookup(data[i]);
    accumulatedBits += 6;
    // "If buffer has accumulated 24 bits, interpret them as three 8-bit
    // big-endian numbers. Append three bytes with values equal to those
    // numbers to output, in the same order, and then empty buffer."
    if (accumulatedBits === 24) {
      output += String.fromCharCode((buffer & 0xff0000) >> 16);
      output += String.fromCharCode((buffer & 0xff00) >> 8);
      output += String.fromCharCode(buffer & 0xff);
      buffer = accumulatedBits = 0;
    }
    // "Advance position by 1."
  }
  // "If buffer is not empty, it contains either 12 or 18 bits. If it contains
  // 12 bits, then discard the last four and interpret the remaining eight as
  // an 8-bit big-endian number. If it contains 18 bits, then discard the last
  // two and interpret the remaining 16 as two 8-bit big-endian numbers. Append
  // the one or two bytes with values equal to those one or two numbers to
  // output, in the same order."
  if (accumulatedBits === 12) {
    buffer >>= 4;
    output += String.fromCharCode(buffer);
  } else if (accumulatedBits === 18) {
    buffer >>= 2;
    output += String.fromCharCode((buffer & 0xff00) >> 8);
    output += String.fromCharCode(buffer & 0xff);
  }
  // "Return output."
  return output;
}
/**
 * A lookup table for atob(), which converts an ASCII character to the
 * corresponding six-bit number.
 */
function atobLookup(chr) {
  if (/[A-Z]/.test(chr)) {
    return chr.charCodeAt(0) - "A".charCodeAt(0);
  }
  if (/[a-z]/.test(chr)) {
    return chr.charCodeAt(0) - "a".charCodeAt(0) + 26;
  }
  if (/[0-9]/.test(chr)) {
    return chr.charCodeAt(0) - "0".charCodeAt(0) + 52;
  }
  if (chr === "+") {
    return 62;
  }
  if (chr === "/") {
    return 63;
  }
  // Throw exception; should not be hit in tests
  return undefined;
}

function extractJSFromHTA(s) {
    const root = parse("" + s);
    items = root.querySelectorAll('script');
    r = "";
    var chunkNum = 0;
    for (let i1 = 0; i1 < items.length; ++i1) {
        item = items[i1];
        for (let i2 = 0; i2 < item.childNodes.length; ++i2) {
            chunkNum += 1;
            child = item.childNodes[i2]
            attrs = ("" + child.parentNode.rawAttrs).toLowerCase();
            if (!attrs.includes("vbscript")) {
                r += "// Chunk #" + chunkNum + "\n" + child._rawText + "\n\n";
            }
        }
    }
    return r;
}

var location = {
    
    /*
      Location.ancestorOrigins
      Is a static DOMStringList containing, in reverse order, the origins
      of all ancestor browsing contexts of the document associated with
      the given Location object.
    */
    ancestorOrigins: '',
    
    /* 
       Location.href
       Is a stringifier that returns a USVString containing the entire
       URL. If changed, the associated document navigates to the new
       page. It can be set from a different origin than the associated
       document.
    */
    href: 'http://mylegitdomain.com:2112/and/i/have/a/path.php',

    /* 
       Location.protocol
       Is a USVString containing the protocol scheme of the URL, including
       the final ':'.
    */
    protocol: 'http:',

    /* 
       Location.host
       Is a USVString containing the host, that is the hostname, a ':', and
       the port of the URL.
    */
    host: 'mylegitdomain.com:2112',

    /* 
       Location.hostname
       Is a USVString containing the domain of the URL.
    */
    hostname: 'mylegitdomain.com',

    /* 
       Location.port
       Is a USVString containing the port number of the URL.
    */
    port: '2112',

    /* 
       Location.pathname
       Is a USVString containing an initial '/' followed by the path of the URL.
    */
    pathname: '/and/i/have/a/path.php',

    /* 
       Location.search
       Is a USVString containing a '?' followed by the parameters or
       "querystring" of the URL. Modern browsers provide URLSearchParams
       and URL.searchParams to make it easy to parse out the parameters
       from the querystring.
    */
    search: '',

    /* 
       Location.hash
       Is a USVString containing a '#' followed by the fragment identifier
       of the URL.
    */
    hash: '',

    /* 
       Location.origin Read only
       Returns a USVString containing the canonical form of the origin of
       the specific location.
    */
    origin: 'http://mylegitdomain.com:2112',

    replace: function (url) {
        logIOC('Window Location', {url}, "The script changed the window location URL.");
	logUrl('Window Location', {url});
    },

    // The location.reload() method reloads the current URL, like the Refresh button.
    reload: function() {},
};

function __getElementsByTagName(tag) {
    var func = function(item) {
        logIOC('DOM Append', {item}, "The script added a HTML node to the DOM");
        return "";
    };
    
    // Return a dict that maps every tag name to the same fake element.
    fake_dict = {};
    fake_dict = new Proxy(fake_dict, {
        get(target, phrase) { // intercept reading a property from dictionary
            return {
                "appendChild" : func,
                "insertBefore" : func,
                "parentNode" : {
                    "appendChild" : func,
                    "insertBefore" : func,
                },
                "getElementsByTagName" : __getElementsByTagName,
                "title" : "My Fake Title",
                style: {},
                getAttribute: function() { return {}; },
            };
        }
    });
    return fake_dict;
};

function __createElement(tag) {
    var fake_elem = {
        set src(url) {
            logIOC('Remote Script', {url}, "The script set a remote script source.");
            logUrl('Remote Script', {url});
        },
        log: [],
	style: [],
	appendChild: function() {
            return __createElement("__append__");
        },
        attributes: {},
        setAttribute: function(name, val) {
            this.attributes[name] = val;
        },
        getAttribute: function(name) {
            return this.attributes[name];
        },        
        firstChild: {
            nodeType: 3,
        },
        lastChild: {
            nodeType: 3,
        },
        getElementsByTagName: __getElementsByTagName,
        // Probably wrong, fix this if it causes problems.
        querySelector: function(tag) {
            return __createElement(tag);
        },
        setAttribute : function() {},
        cloneNode: function() {
            return __createElement("__clone__");
        },
        toLowerCase: function() {
            return "// NOPE";
        },
        click: function() {
            lib.info("click() method called on a document element.");
        },
    };
    return fake_elem;
};

// Stubbed global navigator object.
var navigator = {
    userAgent: 'Mozilla/4.0 (compatible; MSIE 7.0; Windows NT 6.2; WOW64; Trident/6.0; .NET4.0E; .NET4.0C; .NET CLR 3.5.30729; .NET CLR 2.0.50727; .NET CLR 3.0.30729; Tablet PC 2.0; InfoPath.3)',
};

// Stubbed global document object.
var document = {
    documentMode: 8, // Fake running in IE8
    nodeType: 9,
    referrer: 'https://bing.com/',
    body: __createElement("__document_body__"),
    location: location,
    head: {
        innerHTML: "",
        append: function(x) {
            console.log(x);
        },
    },
    defaultView: {},
    cookie: "",
    ready: function(func) {
        func();
    },
    elementCache : {},
    getElementById : function(id) {

        // Already looked this up?
        if (typeof(this.elementCache[id]) !== "undefined") return this.elementCache[id];
        
        var char_codes_to_string = function (str) {
            var codes = ""
            for (var i = 0; i < str.length; i++) {
                codes += String.fromCharCode(str[i])
            }
            return codes
        }

        /* IDS_AND_DATA */
        
        if (typeof(ids) != "undefined") {
            for (var i = 0; i < ids.length; i++) {
                if (char_codes_to_string(ids[i]) == id) {
                    var r = {
                        innerHTML: char_codes_to_string(data[i]),
                        innerText: char_codes_to_string(data[i]),
                        onclick: undefined,
                        click: function() {
                            if (typeof(this.onclick) !== "undefined") this.onclick();
                        },
                        getAttribute: function(attrId) {
                            return this.attrs[attrId];
                        }
                    };
                    r.attrs = attrs[i];
                    this.elementCache[id] = r;
                    return r;                    
                }
            }
        }

        // got nothing to return. Make up some fake element and hope for the best.
        return __createElement(id);
    },
    documentElement: {
        style: {},
        className: "",
    },
    write: function (content) {
        logIOC('DOM Write', {content}, 'The script wrote to the DOM')
        eval.apply(null, [extractJSFromHTA(content)]);
    },
    appendChild: function(node) {
        logIOC('DOM Append', {node}, "The script appended an HTML node to the DOM")
        eval(extractJSFromHTA(node));
    },
    insertBefore: function(node) {
	logIOC('DOM Insert', {node}, "The script inserted an HTML node on the DOM")
        eval(extractJSFromHTA(node));
    },
    getElementsByTagName: __getElementsByTagName,
    createDocumentFragment: function() {
        return __createElement("__doc_fragment__");
    },
    createElement: __createElement,
    createTextNode: function(text) {},
    addEventListener: function(tag, func) {}
};

// Stubbed global window object.
var window = {
    eval: function(cmd) { eval(cmd); },
    resizeTo: function(a,b){},
    moveTo: function(a,b){},
    close: function(){},
    matchMedia: function(){ return {}; },
    atob: function(s){
        return atob(s);
    },
    setTimeout: function(f, i) {},
    addEventListener: function(){},
    attachEvent: function(){},
    getComputedStyle: function(){
	return ["??",
		"-moz-"];
    },
    createDocumentFragment: function() {},
    createElement: __createElement,    
    location: location,
    localStorage: {
        // Users and session to distinguish and generate statistics about website traffic. 
        "___utma" : undefined,
        // Users and session to distinguish and generate statistics about website traffic. 
        "__utma" : undefined,
        // Determine new sessions and visits and generate statistics about website traffic. 
        "__utmb" : undefined,
        // Determine new sessions and visits and generate statistics about website traffic. 
        "__utmc" : undefined,
        // Process user requests and generate statistics about the website traffic. 
        "__utmt" : undefined,
        // Store customized variable data at visitor level and generate statistics about the website traffic. 
        "__utmv" : undefined,
        // To record the traffic source or campaign how users ended up on the website. 
        "__utmz" : undefined,
    },
    document: document,
    navigator: navigator,
    _NavbarView: class _NavbarView {
        constructor() {};    
    },
};

// Initial stubbed object. Add items a needed.
var screen = {
};

// Initial stubbed object. Add items a needed.
var ShareLink = {
};

// Initial stubbed function. Add items a needed.
function define(path, func) {
    // Run the function.
    func({}, {}, {}, {}, {});
};
define.amd = true;

// These could be due to a bug in a sample, but added this to
// get analysis to work. Also could be missing globals from other scripts.
wp = {};
wprentals_map_general_start_map = function() {};
googlecode_property_vars = {};
wprentals_map_general_cluster = function() {};
wprentals_map_general_spiderfy = function() {};
wpestate_initialize_poi = function() {};
Codevz_Plus = {};

// Initial stubbed function. Add items a needed.
function adjustIframes() {};

// Initial jQuery stubbing. Add items a needed.

// Function form of jQuery().
var funcDict = {
    on: function(){ return funcDict },
    val: function() {},
    scroll: function() {},
    ready: function() {},
    document: function() {},
    load: function() {},
    extend: function() { return {}; },
    attr: function(field) { return ".attr(" + field + ")"; },
    codevzPlus: function() {},
    hasClass: function() { return false; },
    attr: function() {},
    attrHooks: {
        value: {
            get: function() {},
            set: function() {},
        },
    },
    support: {
        boxModel: false,
    },
    boxModel: false,
    ajaxSetup: function() {},
    event: {
        add: function() {},
        remove: function() {},
        trigger: function() {},
        special: {},
    },
    each: function() {},
    one: function() {},
    mouseup: function() {},
    isFunction: function() {},
    data: function() { return "12"; },
    outerHeight: function() {},
    css: function() {},
    // Probably not jQuery
    avia_sc_messagebox: function() {},
    trigger: function() {},
    width: function() {},
    resize: function() {},
    blur: function() {},
};
var jQuery = function(field){
    if (typeof(field) != "undefined") {
        return field;
    };
    return funcDict;
};

// Global object form of jQuery.
$ = jQuery; // Ugh, shorthand name.
jQuery.jquery = "2.6.1";
jQuery.fn = {
    jquery: "2.6.1",
    extend: function() { return {}; },
    toggle: function() {},
    live: function() {},
    die: function() {},
    load: function() {},
    revolution: {
        is_mobile: function() {},
        is_android: function() {},
    },
    smoothScroll: {},
};
jQuery.extend = function() { return {}; };
jQuery.attr = function() {};
jQuery.attrHooks = {
    value: {
        get: function() {},
        set: function() {},
    },
};
jQuery.support = {
    boxModel: false,
};
jQuery.boxModel = false;
jQuery.ajaxSetup = function() {};
jQuery.event = {
    add: function() {},
    remove: function() {},
    trigger: function() {},
    special: {},
};
jQuery.each = function() {};
jQuery.isFunction = function() {};
jQuery.expr = {
    pseudos: {},
};

// Looks like that can be a window field.
window.jQuery = jQuery

// Initial WebPack stubbing.
globalThis.location = location;
globalThis.importScripts = true;

// Mejs module stubbing.
var mejs = {
    plugins: {},
    Utils: {},
};

// MediaElementPlayer module stubbing.
var MediaElementPlayer = {
    prototype: {},
};

// Vue module stubbing.
class Vue {
    constructor() {};    
};
Vue.directive = function() {};
Vue.component = function() {};

// What is this?
var N2R = N2D = function() {};

// No Element class in node-js.
class Element {
    constructor() {};
};

class _WidgetInfo {
    constructor(a1, a2, a3, a4, a5) {};
};

var _WidgetManager = {
    _Init: function(a1, a2, a3) {},
    _SetDataContext: function(a1) {},
    _RegisterWidget: function(a1, a2) {},
};

// We are acting like cscript when emulating. JS in cscript does not
// implement Array.reduce().
Array.prototype.reduce = function(a, b) {
    throw "CScript JScript has no Array.reduce() method."
};

function setTimeout(func, time) {
    func();
};
function clearTimeout() {};
function setInterval() {};
function clearInterval() {};

class XMLHttpRequest {
    constructor(){
        this.method = null;
        this.url = null;
    };

    addEventListener() {};

    open(method, url) {
        this.method = method;
        this.url = url;
        lib.logIOC("XMLHttpRequest", {method: method, url: url}, "The script opened a HTTP request.");
        lib.logUrl("XMLHttpRequest", url);
    };

    send() {};
};

// Some JS checks to see if these are defined. Do very basic stubbing
// until better stubbing is needed.
exports = {};
module = {};
