# Generic software repository template   
This is a template repository for software published by the energiegedrag-nl.

## Table of contents
* [General info](#general-info)
* [Deploying](#deploying)
* [Developing](#developing) 
* [Features](#features)
* [Contributing](#contributing)
* [Status](#status)
* [License](#license)
* [Credits](#credits)

## General info
Include general information about your repository here. What is purpose of the code in the repo? Motivation? 

## Deploying
This section describes how you can deploy binary releases of the firmware, i.e. without changing the source code, without a development environment and without needing to compile the source code.

### Prerequisites
Describe which (hardware and) software you need before you can deploy the software. If the prerequisites are different the same for deploying users and developing users, you may want to merge the prerequisites sections.

### Other steps 
Describe how the reader can download and install the lastest installable version(s). If appropriate, link to the latest binary release or package you published in the repo. If needed, describe this for different platforms.
Use steps if the procedure is non-trivial:
1. first step;
2. second step;
3. final step.

Format any scripts or commands in a way that makes them  easy to copy, like the following example. 

Forgotten your Wi-Fi password? No problem with the follwing command, replacing `SSID` with the Wi-Fi name of your own Wi-Fi network: 
```shell
netsh wlan show profile SSID key=clear
```

## Developing
This section describes how you can change the source code using a development environment and compile the source code into a binary release of the firmware that can be deployed, either via the development environment, or via the method described in the section [Deploying](#deploying).

### Prerequisites
Describe which (hardware and) software you need before you can change or extend the source code. If the prerequisites are different the same for deploying users and developing users, you may want to merge the prerequisites sections.

## Features
List of features ready and TODOs for future development. Ready:
* awesome feature 1;
* awesome feature 2;
* awesome feature 3.

To-do:
* wow improvement to be done 1;
* wow improvement to be done 2.

## Contributing
See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status
Project is: _in progress_, _finished_, _no longer continued_ and why?

## License
This software is available under the [Apache 2.0 license](./LICENSE), Copyright <year> <copyright holder> 

## Credits

Author(s):
* <name> · [@<github_handle>](https://github.com/<github_handle>)

Thanks to:
* <name> · [@<github_handle>](https://github.com/<github_handle>)

If this repository continues an earlier one, say so here, link it, and thank its authors.

We use and gratefully acknowledge the efforts of the makers of the following source code and libraries:
* [library name 1 and version](library 1 URL), by <copyright holder name 1>, licensed under [license 1 name](license1 URL)
* [library name 2 and version](library 2 URL), by <copyright holder name 2>, licensed under [license 2 name](license2 URL)
* [library name 3 and version](library 3 URL), by <copyright holder name 3>, licensed under [license 3 name](license3 URL)
* etc.

### AI assistance

*(Keep this section only if AI tools contributed.)* Parts of this repository were made with <tool, e.g. [Claude Code](https://claude.com/claude-code) (Anthropic)>, under the author's direction and review. Commits made this way carry a `Co-Authored-By:` trailer. The author remains responsible for all content.
