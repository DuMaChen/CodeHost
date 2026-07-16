package main

import (
	"encoding/json"
	"os"
	"syscall"
)

func main() {
	args := os.Args[1:]
	command := ""
	bundle := ""
	for index, argument := range args {
		if command == "" && (argument == "create" || argument == "run" || argument == "delete") {
			command = argument
		}
		if index > 0 && args[index-1] == "--bundle" {
			bundle = argument
		}
	}
	if command == "create" && bundle != "" {
		path := bundle + "/config.json"
		if data, err := os.ReadFile(path); err == nil {
			var spec map[string]any
			if json.Unmarshal(data, &spec) == nil {
				if linux, ok := spec["linux"].(map[string]any); ok {
					delete(linux, "resources")
					delete(linux, "cgroupsPath")
				}
				if mounts, ok := spec["mounts"].([]any); ok {
					for _, item := range mounts {
						mount, ok := item.(map[string]any)
						if !ok || mount["destination"] != "/dev/pts" {
							continue
						}
						options, ok := mount["options"].([]any)
						if !ok {
							continue
						}
						for optionIndex, option := range options {
							if value, ok := option.(string); ok && len(value) > 4 && value[:4] == "gid=" {
								options[optionIndex] = "gid=0"
							}
						}
					}
				}
				if output, err := json.Marshal(spec); err == nil {
					_ = os.WriteFile(path, append(output, '\n'), 0o644)
				}
			}
		}
	}
	_ = syscall.Exec("/bin/runc.real", append([]string{"runc"}, args...), os.Environ())
	os.Exit(127)
}
