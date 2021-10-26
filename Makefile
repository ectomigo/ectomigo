build: clean
	cp -r ../core/lib .
	# TODO wire this in better
	jq -s '(.[1].dependencies=(.[1].dependencies * .[0].dependencies))[1]' ../core/package.json github.package.json > package.json
	npm i
	mkdir ./babel
	npx babel --plugins @babel/plugin-transform-modules-commonjs --ignore ./dist --ignore ./node_modules --out-dir ./babel ./ 
	mkdir ./dist
	npx ncc build ./babel/index.js --license licenses.txt

clean:
	rm -r ./lib
	rm -r ./babel
	rm -r ./dist

build-test:
	rm -r ./test
	mkdir ./test
	cp -r ../test/*.sql ../test/migrations ../test/package.json ./test
