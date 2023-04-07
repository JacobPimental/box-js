const lib = require("../lib");

function ShellApplication(name) {
	this.shellexecute = (file, args = "", dir = "") => lib.runShellCommand(dir + file + " " + args);
	this.namespace = (folder) => {
		lib.info("Getting namespace: " + folder)
		var folders = {
		};

		if (!(folder in folders))
			folders[folder] = folder;
			//throw new Error(`Unknown ShellApplication.Namespace ${folder}`);

		return {
			Items: function() {
				return {
					Item: function() {
						return folders[folder]
					}
				}
			},

			CopyHere: (vItem) => {
				lib.info("Copying Item: " + JSON.stringify(vItem));
			}
		};
	};
}

module.exports = lib.proxify(ShellApplication, "ShellApplication");
