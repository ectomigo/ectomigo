build:
	rm -r ./lib
	cp -r ../core/lib .
	# TODO wire this in better
	jq -s '(.[1].dependencies=(.[1].dependencies * .[0].dependencies))[1]' ../core/package.json github.package.json > package.json
	npm i
