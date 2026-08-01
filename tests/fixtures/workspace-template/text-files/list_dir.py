import os

root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
output_file = os.path.join(root_dir, "file_list.txt")

with open(output_file, "w", encoding="utf-8") as f:
    for dirpath, dirnames, filenames in os.walk(root_dir):
        level = dirpath.replace(root_dir, "").count(os.sep)
        indent = "│   " * level + "├── " if level > 0 else ""
        f.write(f"{indent}{os.path.basename(dirpath)}/\n")
        subindent = "│   " * (level + 1)
        for filename in filenames:
            f.write(f"{subindent}├── {filename}\n")
