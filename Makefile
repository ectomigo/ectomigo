build:
	rm -r ./lib
	cp -r ../core/lib .
	# TODO wire this in better
	jq -s '(.[1].dependencies=(.[1].dependencies * .[0].dependencies))[1]' ../core/package.json github.package.json > package.json
	npm i
	npx ncc build index.js --license licenses.txt

build-test:
	rm -r ./test
	mkdir ./test
	cp -r ../test/*.sql ../test/migrations ../test/package.json ./test
